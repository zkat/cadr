'use strict'

const BB = require('bluebird')

const cacache = require('cacache')
const fs = BB.promisifyAll(require('graceful-fs'))
const mkdirp = BB.promisify(require('mkdirp'))
const packlist = require('npm-packlist')
const path = require('path')

const MAX_BULK_SIZE = 1 * 1024 * 1024 // 1MB

const contentPath = require('cacache/lib/content/path.js')

module.exports.get = get
function get (cache, key, dest, opts) {
  opts = Object.assign({}, opts || {})
  delete opts.integrity
  return cacache.get(cache, key, opts).then(info => {
    const dirs = new Set()
    const files = JSON.parse(info.data.toString('utf8'))
    return BB.map(Object.keys(files), f => {
      const fdest = path.join(dest, f)
      const fstat = files[f]
      return BB.resolve()
      .then(() => {
        const dir = path.dirname(fdest)
        if (!dirs.has(dir)) {
          return mkdirp(dir).then(() => dirs.add(dir))
        }
      })
      .then(() => {
        if (opts.link) {
          return fs.linkAsync(contentPath(cache, fstat.integrity), fdest)
        } else {
          return cacache.get.copy.byDigest(cache, fstat.integrity, fdest, {
            mode: opts.fmode || fstat.mode,
            mtime: fstat.mtime,
            unsafe: opts.unsafe
          })
        }
      })
    }, {concurrency: 100})
  })
}

module.exports.put = put
function put (cache, key, file, opts) {
  opts = Object.assign({}, opts || {})
  delete opts.integrity
  return BB.resolve(packlist({path: file}))
  .then(files => BB.map(files, f => {
    return _put(cache, key, path.join(file, f), f, opts)
  }), {concurrency: 10})
  .then(stats => stats.reduce((acc, info) => {
    if (info) {
      acc[info.path] = info
    }
    return acc
  }, {}))
  .then(meta => cacache.put(cache, key, JSON.stringify(meta), opts))
}

function _put (cache, key, file, fname, opts) {
  opts = Object.assign({}, opts || {})
  delete opts.integrity
  return fs.statAsync(file).then(stat => {
    if (!stat.isFile()) {
      // ignored. We don't do things like symlinks rn
    } else if (stat.size < MAX_BULK_SIZE) {
      return fs.readFileAsync(file).then(data => {
        return cacache.put(
          cache, `${key}:${fname}`, data, Object.assign({}, opts, {
            mtime: +stat.time,
            mode: stat.mode,
            metadata: stat
          })
        )
      }).then(integrity => Object.assign({path: fname, integrity}, stat))
    } else {
      let integrity
      return BB.fromNode(cb => {
        const from = fs.createReadStream(file)
        const to = cacache.put.stream(
          cache, `${key}:${fname}`, Object.assign({}, opts, {
            mtime: +stat.mtime,
            mode: stat.mode,
            metadata: stat
          }
        )).on('integrity', i => { integrity = i })
        from.on('error', cb)
        to.on('error', cb)
        to.on('finish', () => cb())
        from.pipe(to)
      }).then(() => Object.assign({path: fname, integrity}, stat))
    }
  }).catch({code: 'ENOENT'}, err => {
    if (err.code !== 'ENOENT') {
      throw err
    }
  })
}

module.exports.rm = rm
function rm (cache, key, opts) {
  opts = Object.assign({}, opts)
  return cacache.get(cache, key, opts).then(info => {
    const files = JSON.parse(info.data.toString('utf8'))
    return BB.map(Object.keys(files), f => {
      return cacache.rm(cache, `${key}:${f}`, opts).then(() => {
        if (opts.content) {
          return cacache.rm.content(cache, files[f].integrity)
        }
      })
    }, {concurrency: 5})
  })
}
