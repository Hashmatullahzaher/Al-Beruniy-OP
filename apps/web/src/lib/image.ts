// Read an image File, downscale it (keeps localStorage small and load fast),
// and return a JPEG data URL. Falls back to the raw data URL if canvas fails.
export function fileToScaledDataUrl(file: File, max = 900, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => {
      const raw = reader.result as string
      const img = new Image()
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height))
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(raw)
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch {
          resolve(raw)
        }
      }
      img.onerror = () => resolve(raw)
      img.src = raw
    }
    reader.readAsDataURL(file)
  })
}
