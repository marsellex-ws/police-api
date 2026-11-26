import { DOMParser } from '@xmldom/xmldom';
import { unzipSync } from 'fflate';

const maxXmlSize = 4 * 1024 * 1024;
const files = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml']);
const departments = new Map([
  ['полиция лс','LSPD'], ['полиция сф','SFPD'], ['полиция лв','LVPD'], ['министерство','MINISTRY'],
]);
const dayMs = 86400000;
const all = (node, tag) => node ? Array.from(node.getElementsByTagName(tag)) : [];
const first = (node, tag) => all(node,tag)[0];

function isoDate(date) {
  if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) {
    throw Error('Invalid appointment date');
  }
  return date.toISOString().slice(0,10);
}

function appointmentDate(cell, value, date1904) {
  const kind = cell?.getAttribute('t');
  if ((!kind || kind === 'n') && value && Number.isFinite(Number(value))) {
    return isoDate(new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(Number(value)) * dayMs));
  }
  const parts = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const normalized = parts ? parts[3] + '-' + parts[2].padStart(2,'0') + '-' + parts[1].padStart(2,'0') : value.slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw Error('Missing appointment date');
  const parsed = isoDate(new Date(normalized + 'T00:00:00Z'));
  if (parsed !== normalized) throw Error('Invalid appointment date');
  return parsed;
}

export function parseChiefTerms(bytes) {
  const zip = unzipSync(bytes, {filter: file => file.originalSize <= maxXmlSize &&
    files.has(file.name)});
  const parser = new DOMParser({onError(level) {if (level !== 'warning') throw Error('Invalid spreadsheet XML');}});
  const decoder = new TextDecoder();
  function xml(name) {
    if (!zip[name]) throw Error('Missing spreadsheet XML');
    const contents = decoder.decode(zip[name]);
    if (/<!DOCTYPE|<!ENTITY/i.test(contents)) throw Error('Unexpected XML declaration');
    return parser.parseFromString(contents,'application/xml');
  }

  const workbook = xml('xl/workbook.xml');
  const sheet = all(workbook,'sheet').find(node => node.getAttribute('name') === 'ПД');
  if (!sheet) throw Error('Missing ПД worksheet');
  const relation = all(xml('xl/_rels/workbook.xml.rels'),'Relationship')
    .find(node => node.getAttribute('Id') === sheet.getAttribute('r:id'));
  const target = relation?.getAttribute('Target') || '';
  const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) throw Error('Invalid worksheet path');
  zip[path] = unzipSync(bytes,{filter: file => file.name === path && file.originalSize <= maxXmlSize})[path];
  const date1904 = /^(1|true)$/.test(first(workbook,'workbookPr')?.getAttribute('date1904') || '');

  const styles = xml('xl/styles.xml');
  const fills = all(first(styles,'fills'),'fill');
  const colorByStyle = all(first(styles,'cellXfs'),'xf').map(style => {
    const fill = first(fills[Number(style.getAttribute('fillId'))],'patternFill');
    return fill?.getAttribute('patternType') === 'solid' ? first(fill,'fgColor')?.getAttribute('rgb').slice(-6).toUpperCase() : '';
  });
  const shared = zip['xl/sharedStrings.xml'] ? all(xml('xl/sharedStrings.xml'),'si')
    .map(entry => all(entry,'t').map(node => node.textContent).join('')) : [];
  function value(cell) {
    if (!cell) return '';
    const raw = first(cell,'v')?.textContent || '';
    const type = cell.getAttribute('t');
    if (type === 's') return (shared[Number(raw)] || '').trim();
    return (type === 'inlineStr' ? all(cell,'t').map(node => node.textContent).join('') : raw).trim();
  }

  const rows = all(xml(path),'row');
  const entries = new Map();
  let headerSeen = false;
  let greenSeen = false;
  for (const row of rows) {
    const cells = Object.fromEntries(all(row,'c').map(cell => [cell.getAttribute('r').replace(/\d+$/,''),cell]));
    const group = value(cells.A);
    const name = value(cells.B);
    if (group === 'Фракция' && name === 'Ник' && value(cells.D) === 'Дата назначения') headerSeen = true;
    const department = departments.get(group.toLowerCase().replace(/^[^а-яё]+/u,'').trim());
    if (!department || !name || colorByStyle[Number(cells.B.getAttribute('s'))] !== 'D9EAD3') continue;
    greenSeen = true;
    if (/^вакантно/i.test(name) || !['','-','—','–'].includes(value(cells.E))) continue;
    const appointedOn = appointmentDate(cells.D,value(cells.D),date1904);
    const previous = entries.get(department);
    if (previous?.appointed_on === appointedOn && previous.nickname !== name) throw Error('Two active leaders share an appointment date');
    if (!previous || previous.appointed_on < appointedOn) entries.set(department,{
      department,nickname:name.slice(0,100),appointed_on:appointedOn,
    });
  }
  if (!headerSeen || !greenSeen) throw Error('Expected headers or active highlights not found');
  return [...departments.values()].filter(department => entries.has(department)).map(department => entries.get(department));
}
