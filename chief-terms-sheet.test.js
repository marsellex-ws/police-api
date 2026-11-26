import test from 'node:test';
import assert from 'node:assert/strict';
import {strToU8,zipSync} from 'fflate';
import {parseChiefTerms} from './chief-terms-sheet.js';

const cell = (column,row,text,style=0) => '<c r="'+column+row+'" s="'+style+'" t="inlineStr"><is><t>'+text+'</t></is></c>';
const row = (index,group,name,appointed,removed,style) => '<row r="'+index+'">'+
  cell('A',index,group)+cell('B',index,name,style)+cell('D',index,appointed)+cell('E',index,removed)+'</row>';

function sheet(rows) {
  return zipSync(Object.fromEntries(Object.entries({
    'xl/workbook.xml':'<workbook xmlns:r="urn:relationships"><sheets><sheet name="ПД" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml':'<styleSheet><fills><fill/><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAD3"/></patternFill></fill></fills><cellXfs><xf fillId="0"/><xf fillId="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':'<worksheet><sheetData>'+row(1,'Фракция','Ник','Дата назначения','Дата снятия',0)+rows.join('')+'</sheetData></worksheet>',
  }).map(([name,contents])=>[name,strToU8(contents)])));
}

test('imports only green named occupants and their appointment date',()=>{
  assert.deepEqual(parseChiefTerms(sheet([
    row(2,'📘 Полиция СФ','Archived','2026-10-03','-',0),
    row(3,'📗 Полиция ЛВ','Вакантно (обзвон)','','',1),
    row(4,'📘 Полиция СФ','Removed','2026-10-05','2026-10-20',1),
    row(5,'📗 Полиция ЛВ','Current','18.10.2026','-',1),
    row(6,'📘 Полиция СФ','New_Leader','2026-11-13','-',1),
  ])),[
    {department:'SFPD',nickname:'New_Leader',appointed_on:'2026-11-13'},
    {department:'LVPD',nickname:'Current',appointed_on:'2026-10-18'}
  ]);
});

test('a worksheet missing active highlights is rejected',()=>{
  assert.throws(()=>parseChiefTerms(sheet([row(2,'📙 Полиция ЛС','Officer','2026-11-13','-',0)])),/active highlights/);
});
