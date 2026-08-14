const base64Pattern = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u

export function decodeBase64(value: string): Uint8Array | null {
  if (!base64Pattern.test(value)) {
    return null
  }

  try {
    const binary = atob(value)
    const result = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      result[index] = binary.charCodeAt(index)
    }

    return result
  } catch {
    return null
  }
}

export function encodeBase64(value: Uint8Array): string {
  let binary = ''

  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}
