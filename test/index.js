'use strict'

const BB = require('bluebird')

const fs = BB.promisifyAll(require('fs'))
const path = require('path')
const Tacks = require('tacks')
const test = require('tap').test

const cadr = require('..')

const Dir = Tacks.Dir
const File = Tacks.File
const testDir = require('./util/test-dir.js')(__filename)

test('basic integration', t => {
  const fixture = new Tacks(Dir({
    'foo': Dir({
      'a': File('a'),
      'b': Dir({ 'c': File('c') }),
      'd': File('d')
    })
  }))
  fixture.create(testDir)
  const src = path.join(testDir, 'foo')
  const dest = path.join(testDir, 'target')
  const cache = path.join(testDir, 'cache')
  return cadr.put(cache, 'cadr:test1', src)
    .then(() => cadr.get(cache, 'cadr:test1', dest))
    .then(() => BB.join(
      fs.readFileAsync(path.join(dest, 'a'), 'utf8'),
      fs.readFileAsync(path.join(dest, 'b', 'c'), 'utf8'),
      fs.readFileAsync(path.join(dest, 'd'), 'utf8'),
      (a, c, d) => {
        t.equal(a, 'a', 'toplevel file extracted')
        t.equal(c, 'c', 'file extracted into nested dir')
        t.equal(d, 'd', 'other file extracted into toplevel')
      }
    ))
})

test('original mtime and mode preserved', t => {
  const fixture = new Tacks(Dir({
    'foo': Dir({
      'a': File('a'),
      'b': Dir({ 'c': File('c') })
    })
  }))
  fixture.create(testDir)
  const src = path.join(testDir, 'foo')
  const dest = path.join(testDir, 'target')
  const cache = path.join(testDir, 'cache')
  const mtime = Date.now() - 100000
  return BB.join(
    fs.chmodAsync(path.join(src, 'a'), 0o100766),
    fs.chmodAsync(path.join(src, 'b'), 0o40755),
    fs.chmodAsync(path.join(src, 'b', 'c'), 0o100744),
    fs.utimesAsync(path.join(src, 'a'), Date.now(), mtime)
  )
    .then(() => cadr.put(cache, 'cadr:perms', src))
    .then(() => cadr.get(cache, 'cadr:perms', dest))
    .then(() => BB.join(
      fs.statAsync(path.join(dest, 'a')),
      fs.statAsync(path.join(dest, 'b')),
      fs.statAsync(path.join(dest, 'b', 'c')),
      (aStat, bStat, cStat) => {
        t.equal(aStat.mode, 0o100766, 'mode for file `a` preserved')
        t.equal(bStat.mode, 0o40755, 'mode for dir `b` preserved')
        t.equal(cStat.mode, 0o100744, 'mode for nested file `c` preserved')
        t.equal(+aStat.mtime, mtime * 1000, 'mtime for file `a` preserved')
      }
    ))
})
