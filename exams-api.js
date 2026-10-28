// Police Department electronic examinations API. Server-only module.
const SLUGS = new Set(['private', 'captain']);
const NICK_RE = /^[A-Za-z0-9_]{3,32}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODE = new Set(['single', 'multiple', 'text']);
const MAX_OPTIONS = 12;
const ipAttempts = new Map();

function validateQuestion(input, HttpError) {
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  const exam_slug = String(input.exam_slug || '').trim();
  const answer_mode = String(input.answer_mode || 'single');
  const allow_custom = Boolean(input.allow_custom);
  const question_order = Number(input.question_order || 0);
  const options = Array.isArray(input.options) ? input.options : [];
  const accepted_text = (Array.isArray(input.accepted_text) ? input.accepted_text : [])
    .map(x => String(x).trim()).filter(Boolean);
  if (!SLUGS.has(exam_slug) || title.length < 3 || title.length > 500 || description.length > 3000 ||
      !MODE.has(answer_mode) || !Number.isInteger(question_order) || question_order < 0 || question_order > 10000 ||
      accepted_text.length > 20 || accepted_text.some(x => x.length > 250)) {
    throw new HttpError(400, 'Неверные данные вопроса');
  }
  if (answer_mode === 'text' && (allow_custom || options.length || !accepted_text.length)) {
    throw new HttpError(400, 'Для свободного ответа укажи допустимые ответы');
  }
  if (answer_mode !== 'text') {
    if (options.length < 2 || options.length > MAX_OPTIONS) throw new HttpError(400, 'Нужно от 2 до 12 вариантов ответа');
    const ids = new Set(); let correct = 0;
    for (const option of options) {
      if (!option || typeof option.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(option.id) ||
          typeof option.text !== 'string' || !option.text.trim() || option.text.length > 400 || ids.has(option.id)) {
        throw new HttpError(400, 'Неверный или повторяющийся вариант ответа');
      }
      ids.add(option.id);
      if (option.correct === true) correct++;
    }
    if (!correct || (answer_mode === 'single' && correct !== 1)) {
      throw new HttpError(400, 'Отметь правильные варианты ответа');
    }
    if (allow_custom && !accepted_text.length) throw new HttpError(400, 'Для варианта «Свой ответ» укажи правильные текстовые ответы');
  }
  return {
    exam_slug, title, description, answer_mode, allow_custom: answer_mode !== 'text' && allow_custom,
    question_order,
    options: answer_mode === 'text' ? [] : options.map(o => ({ id:o.id, text:o.text.trim(), correct:o.correct === true })),
    accepted_text: accepted_text.map(x => x.slice(0,250))
  };
}

function publicQuestion(q) {
  return { id:q.id, exam_slug:q.exam_slug, question_order:q.question_order, title:q.title,
    description:q.description, answer_mode:q.answer_mode, allow_custom:q.allow_custom,
    options:(q.options || []).map(o => ({ id:o.id,text:o.text })) };
}

function norm(text) { return String(text).trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU'); }

function throttle(req, HttpError) {
  // This is a small process-local safeguard; the network edge should enforce distributed limits.
  const ip = String(req.socket.remoteAddress || 'unknown').slice(0,80);
  const now=Date.now();
  if (ipAttempts.size > 5000) ipAttempts.clear();
  const entry = ipAttempts.get(ip) || { start:now, count:0 };
  if(now-entry.start>10*60*1000){entry.count=0;entry.start=now;}
  entry.count++;
  ipAttempts.set(ip,entry);
  if(entry.count>12) throw new HttpError(429,'Слишком много попыток. Повтори позже');
}

function reviewQuestion(q,a){
 const chosen=Array.isArray(a?.choice_ids)?a.choice_ids:[];
 const free=typeof a?.free_text==='string'?a.free_text.trim():'';
 const accepted=Array.isArray(q.accepted_text)?q.accepted_text:[];
 const opts=Array.isArray(q.options)?q.options:[];
 const right=opts.filter(o=>o.correct===true).map(o=>o.id);
 let is_correct=false;
 if(free)is_correct=accepted.some(t=>norm(t)===norm(free));
 else if(q.answer_mode==='text')is_correct=false;
 else is_correct=chosen.length===right.length&&chosen.every(id=>right.includes(id));
 return {question_id:q.id,title:q.title,description:q.description||'',answer_mode:q.answer_mode,
   options:opts.map(o=>({id:o.id,text:o.text,correct:o.correct===true})),
   accepted_text:accepted,selected_ids:chosen,free_text:free,is_correct};
}
function grade(questions, answers, HttpError) {
 let score=0;const review=[];
 if(!answers||typeof answers!=='object'||Array.isArray(answers))throw new HttpError(400,'Ответы отсутствуют');
 if(Object.keys(answers).length!==questions.length)throw new HttpError(400,'Ответь на все вопросы');
 const known=new Set(questions.map(q=>q.id));
 if(Object.keys(answers).some(k=>!known.has(k)))throw new HttpError(400,'Обнаружен неизвестный вопрос');
 for(const q of questions){
  const a=answers[q.id];
  if(!a||typeof a!=='object'||Array.isArray(a))throw new HttpError(400,'Не указан ответ на вопрос');
  const choice=Array.isArray(a.choice_ids)?a.choice_ids:[];
  const free=typeof a.free_text==='string'?a.free_text.trim():'';
  if(free.length>1000||choice.length>MAX_OPTIONS||new Set(choice).size!==choice.length)throw new HttpError(400,'Некорректный ответ');
  const ids=new Set((q.options||[]).map(o=>o.id));
  if(choice.some(id=>typeof id!=='string'||!ids.has(id)))throw new HttpError(400,'Выбран неизвестный вариант ответа');
  if(q.answer_mode==='text'){
   if(choice.length||!free)throw new HttpError(400,'Введи свободный ответ');
  }else if(free){
   if(!q.allow_custom||choice.length)throw new HttpError(400,'Свой ответ недоступен для этого вопроса');
  }else if(!choice.length||(q.answer_mode==='single'&&choice.length!==1)){
   throw new HttpError(400,'Выбери вариант ответа');
  }
  const info=reviewQuestion(q,a);if(info.is_correct)score++;review.push(info);
 }
 return {score,review};
}

export async function handleExamRequest({req,res,url,supabase,identity,bodyJson,send,HttpError}) {
  const path=url.pathname;
  if(!path.startsWith('/api/exams')) return false;
  const order='order=question_order.asc,created_at.asc';
  const fields='id,exam_slug,question_order,title,description,answer_mode,allow_custom,options,accepted_text,created_at,updated_at';
  const admin=async()=>{const u=await identity(req);if(!['admin','developer'].includes(u.role))throw new HttpError(403,'Доступно только администратору или разработчику');return u;};
  const known=slug=>{if(!SLUGS.has(slug))throw new HttpError(404,'Экзамен не найден');return slug;};
  const getExam=async slug=>{const a=await supabase('GET',`pd_exams?${new URLSearchParams({slug:`eq.${known(slug)}`,select:'slug,title,description,pass_percent,active',limit:'1'})}`);if(!a?.length)throw new HttpError(404,'Экзамен не найден');return a[0];};
  const getQuestions=slug=>supabase('GET',`pd_exam_questions?${new URLSearchParams({exam_slug:`eq.${known(slug)}`,select:fields,order:'question_order.asc,created_at.asc',limit:'300'})}`);
  const examMatch=/^\/api\/exams\/(private|captain)$/.exec(path);
  const submitMatch=/^\/api\/exams\/(private|captain)\/submit$/.exec(path);
  const manageMatch=/^\/api\/exams\/admin\/(private|captain)$/.exec(path);
  const questionMatch=/^\/api\/exams\/admin\/questions\/([0-9a-f-]+)$/i.exec(path);

  if(req.method==='GET'&&path==='/api/exams'){
    const [exams,questions]=await Promise.all([
      supabase('GET','pd_exams?select=slug,title,description,pass_percent,active&order=created_at.asc'),
      supabase('GET','pd_exam_questions?select=id,exam_slug&limit=500')]);
    send(res,200,{ok:true,exams:exams.filter(x=>x.active).map(x=>({...x,question_count:questions.filter(q=>q.exam_slug===x.slug).length}))});return true;
  }
  if(req.method==='GET'&&examMatch){
    const exam=await getExam(examMatch[1]);if(!exam.active)throw new HttpError(404,'Экзамен недоступен');
    const questions=await getQuestions(exam.slug);
    send(res,200,{ok:true,exam,questions:questions.map(publicQuestion)});return true;
  }
  if(req.method==='POST'&&submitMatch){
    throttle(req,HttpError);
    const slug=known(submitMatch[1]);
    const input=await bodyJson(req,45000);
    const nickname=String(input.nickname||'').trim();
    if(!NICK_RE.test(nickname))throw new HttpError(400,'Укажи игровой ник (3–32 символа, латиница, цифры и _)');
    const exam=await getExam(slug);if(!exam.active)throw new HttpError(404,'Экзамен недоступен');
    const questions=await getQuestions(slug);
    if(!questions.length)throw new HttpError(409,'В этом экзамене пока нет вопросов');
    const {score,review}=grade(questions,input.answers,HttpError), total=questions.length;
    const status=score/total*100>=exam.pass_percent?'passed':'failed';
    const out=await supabase('POST','pd_exam_attempts?select=id,exam_slug,nickname,score,total,pass_percent,status,submitted_at',{
      exam_slug:slug,nickname,answers:input.answers,review,score,total,pass_percent:exam.pass_percent,status
    },{prefer:'return=representation'});
    if(!out?.[0])throw new HttpError(502,'Не удалось сохранить результат');
    send(res,201,{ok:true,result:out[0]});return true;
  }
  // Never expose raw answers, correctness or review snapshots to the public API.
  if(req.method==='GET'&&path==='/api/exams/admin/attempts'){
    await admin();
    const limit=Number(url.searchParams.get('limit')||'20');
    const offset=Number(url.searchParams.get('offset')||'0');
    if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0||offset>100000)throw new HttpError(400,'Некорректная страница');
    const slug=url.searchParams.get('exam_slug')||'';
    const status=url.searchParams.get('status')||'';
    if(slug&&!SLUGS.has(slug))throw new HttpError(400,'Неизвестный экзамен');
    if(status&&!['passed','failed','pending_review'].includes(status))throw new HttpError(400,'Неизвестный статус');
    const q=new URLSearchParams({select:'id,exam_slug,nickname,score,total,pass_percent,status,submitted_at',order:'submitted_at.desc,id.desc',limit:String(limit+1),offset:String(offset)});
    if(slug)q.set('exam_slug',`eq.${slug}`);
    if(status)q.set('status',`eq.${status}`);
    const rows=await supabase('GET',`pd_exam_attempts?${q}`);
    send(res,200,{ok:true,items:rows.slice(0,limit),has_more:rows.length>limit,next_offset:rows.length>limit?offset+limit:null});return true;
  }
  const detailMatch=/^\/api\/exams\/admin\/attempts\/([0-9a-f-]+)$/i.exec(path);
  if(req.method==='GET'&&detailMatch){
    await admin();const id=detailMatch[1];
    if(!ID_RE.test(id))throw new HttpError(400,'Неверный ID сдачи');
    const q=new URLSearchParams({id:`eq.${id}`,select:'id,exam_slug,nickname,answers,review,score,total,pass_percent,status,submitted_at',limit:'1'});
    const found=await supabase('GET',`pd_exam_attempts?${q}`);
    if(!found.length)throw new HttpError(404,'Результат не найден');
    const attempt=found[0];
    const snapshot_available=Array.isArray(attempt.review)&&attempt.review.length>0;
    let review=attempt.review||[];
    if(!snapshot_available){
      const current=await getQuestions(attempt.exam_slug);
      review=current.filter(q=>attempt.answers&&Object.hasOwn(attempt.answers,q.id)).map(q=>reviewQuestion(q,attempt.answers[q.id]));
    }
    const {answers:privateAnswers,review:privateReview,...publicAttempt}=attempt;
    send(res,200,{ok:true,attempt:publicAttempt,review,snapshot_available});return true;
  }
  if(req.method==='GET'&&manageMatch){
    await admin();const exam=await getExam(manageMatch[1]);const questions=await getQuestions(exam.slug);
    send(res,200,{ok:true,exam,questions});return true;
  }
  if(req.method==='PATCH'&&manageMatch){
    await admin(); const slug=known(manageMatch[1]); const input=await bodyJson(req,5000);
    const patch={updated_at:new Date().toISOString()};
    if(Object.hasOwn(input,'title')){const v=String(input.title||'').trim();if(v.length<3||v.length>160)throw new HttpError(400,'Название должно содержать 3–160 символов');patch.title=v;}
    if(Object.hasOwn(input,'description')){const v=String(input.description||'').trim();if(v.length>2000)throw new HttpError(400,'Описание слишком длинное');patch.description=v;}
    if(Object.hasOwn(input,'pass_percent')){const v=Number(input.pass_percent);if(!Number.isInteger(v)||v<1||v>100)throw new HttpError(400,'Процент сдачи должен быть от 1 до 100');patch.pass_percent=v;}
    if(Object.hasOwn(input,'active'))patch.active=input.active===true;
    await supabase('PATCH',`pd_exams?slug=eq.${slug}`,patch);
    send(res,200,{ok:true});return true;
  }
  if(req.method==='POST'&&path==='/api/exams/admin/questions'){
    const u=await admin();const input=await bodyJson(req,30000);
    const question={...validateQuestion(input,HttpError),created_by:u.login,updated_by:u.login};
    const out=await supabase('POST','pd_exam_questions?select=id',question,{prefer:'return=representation'});
    if(!out?.[0])throw new HttpError(502,'Вопрос не создан');
    send(res,201,{ok:true,id:out[0].id});return true;
  }
  if(questionMatch){
    const id=questionMatch[1];if(!ID_RE.test(id))throw new HttpError(400,'Неверный ID вопроса');
    const u=await admin();
    if(req.method==='PATCH'){
      const input=await bodyJson(req,30000);
      const question={...validateQuestion(input,HttpError),updated_by:u.login,updated_at:new Date().toISOString()};
      const out=await supabase('PATCH',`pd_exam_questions?${new URLSearchParams({id:`eq.${id}`,select:'id'})}`,question,{prefer:'return=representation'});
      if(!out?.[0])throw new HttpError(404,'Вопрос не найден');
      send(res,200,{ok:true});return true;
    }
    if(req.method==='DELETE'){
      const result=await supabase('DELETE',`pd_exam_questions?${new URLSearchParams({id:`eq.${id}`,select:'id'})}`,undefined,{prefer:'return=representation'});
      if(!result?.[0])throw new HttpError(404,'Вопрос не найден');
      send(res,200,{ok:true});return true;
    }
  }
  throw new HttpError(404,'Маршрут экзаменов не найден');
}
