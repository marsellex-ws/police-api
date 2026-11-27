import { readFileSync, writeFileSync } from 'node:fs';
import { load } from 'cheerio';
import { cleanHandbookHtml } from '../handbook-html.js';

const forum = 'https://forum.gta-samp.ru/';
const topic = '884304';
const sections = [
  ['7336620','uk','Уголовный кодекс'],
  ['7336644','ak','Административный кодекс'],
  ['7336739','tk','Транспортный кодекс'],
  ['7336825','upd','Устав полицейского департамента (УПД)'],
  ['7336870','factions','Взаимодействие с фракциями'],
  ['7336882','divisions','Структурные подразделения'],
  ['7337013','roleplay','Примеры RP-отыгровок'],
  ['7337067','radio-codes','Система кодов'],
  ['7337078','commands','Команды'],
  ['7337132','training','Тренировки'],
  ['7580633','checkpoints','Блокпосты и рейды'],
  ['8621014','operations','Специальные операции'],
  ['9038618','promotions','Система повышения'],
  ['9038641','exams','Экзамены и зачёты']
];
const resourceNames = [
  'Спецподразделение SWAT','Нововведения','Чёрный список','Инструкция действий',
  'Информация для лидеров и их заместителей','Квесты для лидеров','Биндеры для сотрудников',
  'Сборник карт для полиции','Обучающее видео для новичков','Police Absolute One во ВКонтакте','Discord'
];
const slugs = new Map(sections.map(([comment, slug]) => [comment, slug]));
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node scripts/import-handbook.mjs forum.html sections.json');
const $ = load(readFileSync(input, 'utf8'));

function post(comment) {
  const node = $(`#elComment_${comment} [data-role=commentContent]`);
  if (node.length !== 1) throw Error(`Missing forum post ${comment}`);
  return node;
}

function link(href) {
  const url = new URL(href, forum);
  const sameTopic = url.origin === new URL(forum).origin && url.search.includes('/topic/' + topic + '-');
  const comment = url.hash.match(/^#(?:comment|findComment)-(\d+)$/i)?.[1] || url.searchParams.get('comment');
  if (comment && slugs.has(comment) && (href.startsWith('#') || sameTopic)) return '#' + slugs.get(comment);
  if (sameTopic && !comment && !url.hash) return '#handbookContents';
  return url.href;
}

const index = post('7336600');
const resources = index.find('svg a').toArray().map(a => $(a).attr('href')).filter(href => !href.startsWith('#'));
if (resources.length !== resourceNames.length || $('[data-role=commentContent]').length !== sections.length + 1) {
  throw Error('The forum topic structure changed. Review the section and link mapping before importing.');
}
const intro = $('<div>');
intro.append('<p>Уточнения и примеры к правилам находятся в раскрывающихся блоках «Скрытый текст».</p>');
intro.append('<h3>Дополнительные материалы</h3>');
const list = $('<ul>').appendTo(intro);
resources.forEach((href, i) => {
  const item = $('<li>').appendTo(list);
  $('<a>').attr('href', link(href)).text(resourceNames[i]).appendTo(item);
  if (i === 7) item.append(' — названия районов, пригородные участки, территории бизнесов и другие карты.');
  if (i === 8) item.append(' — проверяйте дату и сверяйтесь со справочником, так как в ролике есть устаревшая информация.');
  if (i === 9) item.append(' — новости, смены лидеров, конкурсы и деятельность полиции.');
});
const rows = [{slug: 'resources', title: 'Дополнительные материалы', sort_order: 0, body_html: cleanHandbookHtml(intro.html())}];
const compact = html => html.replace(/>\s+</g, (space) => space.includes('\n') ? '> <' : space);

sections.forEach(([comment, slug, title], order) => {
  const body = post(comment);
  const spoilers = body.find('.ipsSpoiler').toArray().reverse();
  spoilers.forEach(spoiler => {
    const original = $(spoiler);
    const label = original.children('.ipsSpoiler_header').text().trim();
    const details = $('<details>');
    details.append($('<summary>').text(label || 'Скрытый текст'));
    details.append(original.children('.ipsSpoiler_contents').contents());
    original.replaceWith(details);
  });
  body.find('a[href]').each((_, a) => $(a).attr('href', link($(a).attr('href'))));
  body.find('iframe[data-embed-src]').each((_, video) => $(video).attr('src', $(video).attr('data-embed-src')));
  body.find('img.ipsEmoji').attr('class','handbook-emoji');
  body.children('span[data-excludequote]').each((_, note) => {
    const entry = $(note);
    const paragraph = $('<p class="handbook-edit-note">').append(entry.contents());
    entry.replaceWith(paragraph);
  });
  if (slug === 'upd') {
    let chapter;
    let number = 0;
    body.contents().toArray().forEach(node => {
      const item = $(node);
      const text = item.text().trim().replace(/\s+/g, ' ');
      if (item.is('p') && new RegExp(`^${number + 1}\\. `).test(text)) {
        number++;
        chapter = $('<details class="handbook-chapter">');
        chapter.append($('<summary>').text('Скрытый текст'));
        chapter.append($('<h3>').append(item.contents()));
        item.replaceWith(chapter);
      } else if (chapter) {
        chapter.append(item);
      }
    });
    if (number !== 13) throw Error('Expected 13 chapters in the UПД post');
  }
  const html = cleanHandbookHtml(compact(body.html()));
  const checked = load(html, {}, false);
  const expectedSpoilers = spoilers.length + (slug === 'upd' ? 13 : 0);
  const sameCount = ['img','iframe','a','table'].every(tag => body.find(tag).length === checked(tag).length);
  if (!sameCount || checked('details').length !== expectedSpoilers) throw Error(`Lost content in ${slug}`);
  rows.push({slug, title, sort_order: order + 1, body_html: html});
});
writeFileSync(output, '[\n' + rows.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n');
console.log(`Imported ${rows.length - 1} forum posts and ${resourceNames.length} resources.`);
