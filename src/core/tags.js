/** 从探测结果里取常见标签，填进表单 */

const ALIASES = {
  title: ['title', 'TITLE', 'TIT2'],
  artist: ['artist', 'ARTIST', 'TPE1', 'album_artist_artist'],
  album: ['album', 'ALBUM', 'TALB'],
  albumArtist: ['albumartist', 'album_artist', 'ALBUMARTIST', 'ALBUM_ARTIST', 'TPE2'],
  genre: ['genre', 'GENRE', 'TCON'],
  date: ['date', 'year', 'DATE', 'YEAR', 'TDRC'],
  comment: ['comment', 'COMMENT', 'COMM']
}

const FIELDS = Object.keys(ALIASES)

function readTag(tags, field) {
  if (!tags) return ''
  for (const key of ALIASES[field]) {
    const value = tags[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 把文件的标签映射成表单参数。
 * 只填「当前为空」的字段，避免覆盖用户已经改过的内容。
 */
export function tagsToParams(info, current = {}) {
  const tags = (info && info.tags) || {}
  const out = {}
  for (const field of FIELDS) {
    if (current[field]) continue
    const value = readTag(tags, field)
    if (value) out[field] = value
  }
  return out
}

export function hasAnyTag(info) {
  const tags = (info && info.tags) || {}
  return FIELDS.some((field) => Boolean(readTag(tags, field)))
}
