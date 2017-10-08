'use strict'

const BB = require('bluebird')

const cacache = require('cacache')
const fs = BB.promisifyAll(require('graceful-fs'))
const mkdirp = BB.promisify(require('mkdirp'))
const path = require('path')

const MAX_BULK_SIZE = 1 * 1024 * 1024 // 1MB

module.exports.get = get
function get (cache, key, dest, opts) {
  opts = Object.assign({}, opts || {})
  delete opts.integrity
  return cacache.get(cache, key, opts).then(info => {
    const files = JSON.parse(info.data.toString('utf8'))
    return BB.map(Object.keys(files), f => {
      const fdest = path.join(dest, f)
      const fstat = files[f]
      if (fstat.isDir) {
        return mkdirp(fdest, {mode: opts.dmode || fstat.mode})
        .then(() => fs.utimesAsync(
          fdest, new Date(fstat.atime), new Date(fstat.mtime)
        ))
      } else {
        return mkdirp(path.dirname(fdest))
        .then(() => cacache.get.copy.byDigest(cache, fstat.integrity, fdest))
        .then(() => fs.openAsync(fdest, 'w'))
        .tap(fd => fs.fchmodAsync(fd, opts.fmode || fstat.mode))
        .tap(fd => fs.futimesAsync(
          fd, new Date(fstat.atime), new Date(fstat.mtime)
        ))
        .then(fd => fs.closeAsync(fd))
      }
    }, {concurrency: 100})
  })
}

module.exports.put = put
function put (cache, key, file, opts) {
  opts = Object.assign({}, opts || {})
  delete opts.integrity
  return _put(cache, key, path.resolve(file), '', opts).then(meta => {
    return cacache.put(cache, key, JSON.stringify(meta), opts)
  })
}

function _put (cache, key, file, fname, opts) {
  opts = Object.assign({}, opts || {})
  delete opts.integrity
  return fs.statAsync(file).then(stat => {
    if (stat.isDirectory()) {
      return BB.map(fs.readdirAsync(file), f => {
        return _put(cache, key, path.join(file, f), path.join(fname, f), opts)
      }, {concurrency: 20}).then(files => {
        return files.reduce((acc, info) => {
          if (info) {
            Object.assign(acc, info)
          }
          return acc
        }, {[fname]: Object.assign({isDir: true}, stat)})
      })
    } else if (!stat.isFile()) {
      // ignored. We don't do things like symlinks rn
    } else if (stat.size < MAX_BULK_SIZE) {
      return fs.readFileAsync(file).then(data => {
        return cacache.put(
          cache, `${key}:${fname}`, data, Object.assign({}, opts, {
            metadata: stat
          })
        )
      }).then(integrity => ({[fname]: Object.assign({integrity}, stat)}))
    } else {
      let integrity
      return BB.fromNode(cb => {
        const from = fs.createReadStream(file)
        const to = cacache.put.stream(
          cache, `${key}:${fname}`, Object.assign({}, opts, {
            metadata: stat
          }
        )).on('integrity', i => { integrity = i })
        from.on('error', cb)
        to.on('error', cb)
        to.on('finish', () => cb())
        from.pipe(to)
      }).then(() => ({[fname]: Object.assign({integrity}, stat)}))
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
