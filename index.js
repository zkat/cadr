'use strict'

const BB = require('bluebird')

const cacache = require('cacache')
const fs = BB.promisifyAll(require('graceful-fs'))
const mkdirp = BB.promisify(require('mkdirp'))
const path = require('path')

const MAX_BULK_SIZE = 5 * 1024 * 1024 // 5MB

module.exports.get = get
function get (cache, key, dest, opts) {
  opts = Object.assign({}, opts)
  const start = Date.now()
  let total = 0
  return cacache.get(cache, key, opts).then(info => {
    const files = JSON.parse(info.data.toString('utf8'))
    return BB.map(Object.keys(files), f => {
      total++
      const fdest = path.join(dest, f)
      const fstat = files[f]
      if (fstat.isDir) {
        return mkdirp(fdest)
        .then(() => fs.chmodAsync(fdest, opts.dmode || fstat.mode))
        .then(() => fs.utimesAsync(
          fdest, new Date(fstat.atime), new Date(fstat.mtime)
        ))
      } else {
        return mkdirp(path.dirname(fdest)).then(() => {
          if (fstat.size > MAX_BULK_SIZE) {
            return BB.fromNode(cb => {
              const from = cacache.get.stream.byDigest(cache, fstat.integrity)
              const to = fs.createWriteStream(fdest, {
                mode: opts.fmode || fstat.mode
              })
              from.on('error', cb)
              to.on('error', cb)
              to.on('close', () => cb())
              from.pipe(to)
            })
          } else {
            return cacache.get.byDigest(cache, fstat.integrity).then(d => {
              return fs.writeFileAsync(fdest, d, {
                mode: opts.fmode || fstat.mode
              })
            })
          }
        }).then(() => fs.utimesAsync(
          fdest, new Date(fstat.atime), new Date(fstat.mtime)))
      }
    })
  }).then(() => {
    console.log(`extracted ${total} in ${(Date.now() - start) / 1000}s`)
  })
}

module.exports.put = put
function put (cache, key, file, opts) {
  const start = Date.now()
  return _put(cache, key, path.resolve(file), '', opts).then(meta => {
    return cacache.put(cache, key, JSON.stringify(meta), opts)
  }).then(() => {
    console.log(`done in ${(Date.now() - start) / 1000}s`)
  })
}

function _put (cache, key, file, fname, opts) {
  opts = Object.assign({}, opts || {})
  return fs.statAsync(file).then(stat => {
    if (stat.isDirectory()) {
      return fs.readdirAsync(file).map(f => {
        return _put(cache, key, path.join(file, f), path.join(fname, f), opts)
      }).then(files => {
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
