import imageBlobReduce from 'image-blob-reduce'
import cryptoJs from 'crypto-js'

const JPEG_OUTPUT_QUALITY = 0.98
const JPEG_TYPE = 'image/jpeg'
const PNG_TYPE = 'image/png'
const MAX_FILE_SIZE = 5 * 1024 * 1024

async function processImage(file) {
  const targetPixelCount = getTargetPixelCount(file)
  const newFile = await downsampleRecursively(file, targetPixelCount)
  return newFile
}

const reducer = imageBlobReduce()

/// Патчим библиотеку ImageBlobReduce под наш случай, отличия от исходника отмечены комментариями:
reducer._calculate_size = function (env) {
  let scaleFactor

  // Файл не надо масштабировать, если он меньше порога и его не надо поворачивать
  // (если надо повернуть, все равно будет перекодировка которая может увеличить размер)
  if (
    env.blob.size <= MAX_FILE_SIZE &&
    (!env.orientation || env.orientation === 1)
  ) {
    scaleFactor = 1
  } else {
    // Используем для масштабирования желаемое количество пикселей в результате
    const targetPixelCount = env.opts.targetPixelCount
    const originalPixelCount = env.image.width * env.image.height
    scaleFactor = 1 / Math.sqrt(originalPixelCount / targetPixelCount)
  }

  if (scaleFactor > 1) scaleFactor = 1

  env.transform_width = Math.max(Math.round(env.image.width * scaleFactor), 1)
  env.transform_height = Math.max(Math.round(env.image.height * scaleFactor), 1)

  env.scale_factor = scaleFactor

  return Promise.resolve(env)
}

reducer._transform = function (env) {
  env.out_canvas = this.pica.options.createCanvas(
    env.transform_width,
    env.transform_height
  )

  env.transform_width = null
  env.transform_height = null

  // Не делать никакой обработки, если картинку не надо масштабировать или поворачивать
  if (env.scale_factor === 1 && (!env.orientation || env.orientation === 1)) {
    env.unchanged = true
    return Promise.resolve(env)
  }

  const picaOpts = { alpha: env.blob.type === PNG_TYPE }

  this.utils.assign(picaOpts, this.utils.pick_pica_resize_options(env.opts))

  return this.pica
    .resize(env.image, env.out_canvas, picaOpts)
    .then(function () {
      return env
    })
}

reducer._create_blob = function (env) {
  // Пропустить неизмененный файл без перекодировки
  if (env.unchanged) {
    env.out_blob = env.blob
    env.is_jpeg = false // предотвращает патчинг метаданных плагином jpeg_attach_orig_segments (https://github.com/nodeca/image-blob-reduce/blob/master/lib/jpeg_plugins.js#L82)
    return Promise.resolve(env)
  }

  return this.pica
    .toBlob(
      env.out_canvas,
      env.blob.type,
      env.blob.type === 'image/jpeg' ? JPEG_OUTPUT_QUALITY : undefined // использовать фиксированный quality для JPEG вместо дефолта браузера
    )
    .then(function (blob) {
      env.out_blob = blob
      return env
    })
}

async function downsampleRecursively(file, targetPixelCount) {
  const scaleChangeMultiplier = 1.3
  const newFile = await runImageBlobReduce(file, targetPixelCount)
  if (newFile.size > MAX_FILE_SIZE) {
    const sizeRatio = newFile.size / MAX_FILE_SIZE
    return await downsampleRecursively(
      file,
      targetPixelCount / sizeRatio / scaleChangeMultiplier
    )
  }
  return newFile
}

async function runImageBlobReduce(file, targetPixelCount) {
  const reduced = await reducer.toBlob(file, {
    targetPixelCount
  })
  const newFile = new File([reduced], file.name, { type: file.type })
  return newFile
}

async function checkPngAndConvertToJpegIfNeeded(file, image) {
  try {
    const shouldConvert = await shouldConvertPngToJpeg(file, image)

    if (!shouldConvert) return file

    const blob = await saveImageOnCanvasToBlob(image)
    const newFileName = `${file.name.split('.')[0]}.jpeg`
    return new File([blob], newFileName, { lastModified: new Date().getTime(), type: blob.type })
  } catch (e) {
    return null
  }
}

function saveImageOnCanvasToBlob(image) {
  return new Promise((resolve, reject) => {
    const canvas = document.getElementById('merge-images-canvas')
    if (!canvas) reject()

    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    canvas.toBlob(function(blob) {
      resolve(blob)
    }, JPEG_TYPE, JPEG_OUTPUT_QUALITY)
  })
}

function shouldConvertPngToJpeg(file, image) {
  if (file.type !== PNG_TYPE) return false

  const hasAlpha = hasAlphaChannel(image)

  return !hasAlpha
}

function hasAlphaChannel(img) {
  // check PNG
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height

  const context = canvas.getContext('2d')
  context.drawImage(img, 0, 0)

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data

  let hasTransparentPixels = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) {
      hasTransparentPixels = true
      break
    }
  }

  return hasTransparentPixels
}

function getTargetPixelCount(file) {
  const approximateAchievableCompressionRatio =
    file.type === 'image/jpeg' ? 6 : 2

  const targetSize = MAX_FILE_SIZE * 0.8
  const targetPixelCount =
    (targetSize * approximateAchievableCompressionRatio) / 3

  return targetPixelCount
}

function getFileCheckSum(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = function (event) {
      const binary = event.target.result
      const md5Checksum = cryptoJs.MD5(binary).toString()
      resolve(md5Checksum)
    }
    reader.onerror = function (e) {
      reject(e)
    }
    reader.readAsBinaryString(file)
  })
}

function getFileDimensions(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = function () {
      const image = new Image()
      image.onload = function () {
        resolve({
          height: image.height,
          width: image.width,
          image
        })
      }
      image.onerror = function (e) {
        reject(e)
      }
      image.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

export {
  processImage,
  checkPngAndConvertToJpegIfNeeded,
  getFileCheckSum,
  getFileDimensions
}
