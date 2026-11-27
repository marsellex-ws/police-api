import sanitizeHtml from 'sanitize-html';

const color = /^(?:#[\da-f]{3,8}|[a-z]{1,22}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i;
const length = /^(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|pt|em|rem|%))$/i;
const spacing = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|pt|em|rem|%))(?:\s+(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|pt|em|rem|%))){0,3}$/i;
const family = /^[\p{L}\d"', -]{1,120}$/u;
const align = /^(?:left|right|center|justify|start|end)$/i;

export const handbookSlug = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const handbookBodyLimit = 600000;

export function cleanHandbookHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p','br','hr','div','span','h2','h3','h4','h5','h6','strong','b','em','i','u','s','strike','del',
      'sup','sub','pre','code','blockquote','ol','ul','li','table','caption','thead','tbody','tfoot',
      'tr','th','td','details','summary','img','a','time','font','iframe'
    ],
    allowedAttributes: {
      '*': ['style'],
      a: ['href','title','rel'],
      img: ['src','alt','width','height','loading','class','referrerpolicy'],
      iframe: ['src','title','loading','allowfullscreen','referrerpolicy','sandbox'],
      details: ['class'],
      p: ['class'],
      span: ['class'],
      ol: ['start','type'],
      ul: ['type'],
      li: ['value'],
      th: ['colspan','rowspan','scope'],
      td: ['colspan','rowspan'],
      time: ['datetime','title'],
      font: ['color','face','size']
    },
    allowedClasses: {img: ['handbook-emoji'], details: ['handbook-chapter'], p: ['handbook-edit-note'], span: ['handbook-tab']},
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    allowedIframeHostnames: ['www.youtube.com','www.youtube-nocookie.com'],
    allowIframeRelativeUrls: false,
    allowedStyles: {'*': {
      color: [color],
      'background-color': [color],
      'font-family': [family],
      'font-size': [length, /^(?:xx-small|x-small|small|medium|large|x-large|xx-large)$/i],
      'font-weight': [/^(?:normal|bold|[1-9]00)$/i],
      'font-style': [/^(?:normal|italic|oblique)$/i],
      'text-decoration': [/^(?:(?:underline|line-through|none)\s*){1,2}$/i],
      'text-align': [align],
      'vertical-align': [/^(?:top|middle|bottom|baseline|super|sub)$/i],
      'line-height': [length,/^[1-3](?:\.\d{1,2})?$/],
      'tab-size': [/^[1-8]$/], 'text-indent': [length],
      width: [length], height: [length,/^auto$/i],
      padding: [spacing], 'padding-left': [length], 'padding-right': [length],
      'margin-left': [length], 'margin-right': [length],
      border: [/^[\da-z# .-]{1,50}$/i],
      'border-style': [/^(?:solid|none|dashed|dotted)$/i],
      'border-collapse': [/^(?:collapse|separate)$/i],
      'border-spacing': [spacing],
      'list-style-type': [/^(?:disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)$/i]
    }},
    transformTags: {
      a: (tagName, attribs) => ({tagName, attribs: {...attribs, rel: 'noopener noreferrer'}}),
      img: (tagName, attribs) => ({tagName, attribs: {...attribs, loading: 'lazy', referrerpolicy: 'no-referrer'}}),
      iframe: (tagName, attribs) => ({
        tagName,
        attribs: {
          src: attribs.src, title: 'Видео к справочнику', loading: 'lazy', allowfullscreen: '',
          referrerpolicy: 'strict-origin-when-cross-origin', sandbox: 'allow-scripts allow-same-origin allow-presentation'
        }
      })
    },
    exclusiveFilter: frame => frame.tag === 'iframe' && !frame.attribs.src
  }).trim();
}
