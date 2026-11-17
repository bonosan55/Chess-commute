import { Chess } from './chess.js';

const $ = id => document.getElementById(id);
const GLYPH = { p:'♟', n:'♞', b:'♝', r:'♜', q:'♛', k:'♚' };
const store = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v===null? d : JSON.parse(v);}catch{return d;} },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
};

let game = new Chess();
let myColor = 'w';          // 自分の色
let flipped = false;
let selected = null;
let lastMove = null;
let thinking = false;
let over = false;
let engineReady = false;
let worker;
let waiter = null;          // 'bestmove' 待ち
let eloMin = 1320, eloMax = 3190;

const S = {
  elo: store.get('elo', 1500),
  auto: store.get('auto', false),
  rate: store.get('rate', 1400),   // 自分の推定レート
  games: store.get('games', 0),
  hint: store.get('hint', true),
  mt: store.get('mt', 800),
  hist: store.get('hist', []),
};

/* ---------- Engine ---------- */
function startEngine(){
  worker = new Worker('sf.js');
  worker.onmessage = ev => {
    const line = typeof ev.data === 'string' ? ev.data : '';
    if (line.startsWith('option name UCI_Elo')) {
      const mn = line.match(/min (\d+)/), mx = line.match(/max (\d+)/);
      if (mn && mx) { eloMin = +mn[1]; eloMax = +mx[1]; }
    } else if (line === 'uciok') {
      applyEloRange();
      send('isready');
    } else if (line === 'readyok' && !engineReady) {
      engineReady = true;
      $('status').textContent = 'オフライン対応 ✓';
      restoreOrNew();
    } else if (line.startsWith('bestmove') && waiter) {
      const m = line.split(' ')[1];
      const w = waiter; waiter = null; w(m);
    }
  };
  worker.onerror = () => { $('status').textContent = 'エンジン起動に失敗しました'; };
  send('uci');
}
const send = c => worker.postMessage(c);

function applyEloRange(){
  const el = $('elo');
  el.min = eloMin; el.max = eloMax;
  S.elo = Math.min(eloMax, Math.max(eloMin, S.elo));
  el.value = S.elo;
  $('elomin').textContent = eloMin; $('elomax').textContent = eloMax;
  showElo();
}

function engineMove(){
  return new Promise(resolve => {
    waiter = resolve;
    send('setoption name UCI_LimitStrength value true');
    send('setoption name UCI_Elo value ' + S.elo);
    send('position fen ' + game.fen());
    send('go movetime ' + S.mt);
  });
}

/* ---------- Rendering ---------- */
function sqName(file, rank){ return 'abcdefgh'[file] + (rank + 1); }

function render(){
  const b = $('board'); b.innerHTML = '';
  const board = game.board();
  const targets = new Map();
  if (selected) for (const m of game.moves({ square: selected, verbose: true })) targets.set(m.to, m);
  let kingSq = null;
  if (game.inCheck()) {
    for (let r=0;r<8;r++) for (let f=0;f<8;f++){ const p=board[r][f]; if (p && p.type==='k' && p.color===game.turn()) kingSq = p.square; }
  }
  for (let i=0;i<64;i++){
    const row = Math.floor(i/8), col = i%8;
    const f = flipped ? 7-col : col;
    const r = flipped ? row : 7-row;
    const name = sqName(f, r);
    const p = board[7-r][f];
    const d = document.createElement('div');
    d.className = 'sq ' + ((f + r) % 2 === 0 ? 'd' : 'l');
    d.dataset.sq = name;
    if (S.hint && lastMove && (lastMove.from===name || lastMove.to===name)) d.classList.add('last');
    if (selected === name) d.classList.add('sel');
    if (kingSq === name) d.classList.add('chk');
    if (targets.has(name)) { d.classList.add('tgt'); if (p) d.classList.add('cap'); }
    if (p) {
      const s = document.createElement('span');
      s.className = p.color; s.textContent = GLYPH[p.type];
      d.appendChild(s);
    }
    if (col===0){ const e=document.createElement('i'); e.className='co r'; e.textContent=r+1; d.appendChild(e); }
    if (row===7){ const e=document.createElement('i'); e.className='co f'; e.textContent='abcdefgh'[f]; d.appendChild(e); }
    b.appendChild(d);
  }
  $('oppname').textContent = `相手: Stockfish ${S.elo}  ／  あなた: ${myColor==='w'?'白':'黒'}`;
  $('meta').textContent = over ? '' : (thinking ? '相手が考え中…' : (game.turn()===myColor ? 'あなたの番です' : ''));
  $('myrate').textContent = `推定レート ${Math.round(S.rate)}（${S.games}局）`;
}

function showElo(){
  $('eloval').textContent = S.elo;
  $('auto').textContent = '自動調整 ' + (S.auto ? 'ON' : 'OFF');
  $('auto').setAttribute('aria-pressed', S.auto);
}

/* ---------- Game flow ---------- */
function save(){ store.set('pgn', game.pgn()); store.set('myColor', myColor); store.set('over', over); }

function restoreOrNew(){
  const pgn = store.get('pgn', '');
  if (pgn && !store.get('over', false)) {
    try {
      game = new Chess(); game.loadPgn(pgn); myColor = store.get('myColor', 'w');
      const h = game.history({ verbose: true }); lastMove = h.length ? h[h.length-1] : null;
      flipped = myColor === 'b'; over = false;
      render(); afterMove(); return;
    } catch {}
  }
  newGame();
}

function newGame(){
  game = new Chess(); over = false; thinking = false; selected = null; lastMove = null;
  myColor = Math.random() < 0.5 ? 'w' : 'b';
  flipped = myColor === 'b';
  render(); save(); afterMove();
}

async function afterMove(){
  render();
  if (checkEnd()) return;
  if (game.turn() !== myColor) {
    thinking = true; render();
    const startFen = game.fen();
    const mv = await engineMove();
    thinking = false;
    if (over || game.fen() !== startFen) return;   // 戻す・新規対局された場合は破棄
    if (mv && mv !== '(none)') {
      const m = game.move({ from: mv.slice(0,2), to: mv.slice(2,4), promotion: mv[4] });
      lastMove = m;
    }
    save(); render(); checkEnd();
  }
}

function checkEnd(){
  if (!game.isGameOver()) return false;
  let result, score;
  if (game.isCheckmate()) { const iWon = game.turn() !== myColor; result = iWon ? 'チェックメイト：あなたの勝ち' : 'チェックメイト：あなたの負け'; score = iWon ? 1 : 0; }
  else { result = game.isStalemate() ? 'ステイルメイト（引き分け）' : '引き分け'; score = 0.5; }
  finish(result, score); return true;
}

function finish(text, score){
  if (over) return;
  over = true; save();
  const exp = 1 / (1 + Math.pow(10, (S.elo - S.rate) / 400));
  const K = S.games < 20 ? 40 : 24;
  const before = S.rate;
  S.rate = before + K * (score - exp);
  S.games++;
  S.hist.unshift({ t: new Date().toISOString().slice(0,10), opp: S.elo, s: score, r: Math.round(S.rate) });
  S.hist = S.hist.slice(0, 50);
  if (S.auto) { S.elo = clampElo(Math.round(S.rate)); $('elo').value = S.elo; }
  store.set('rate', S.rate); store.set('games', S.games); store.set('hist', S.hist); store.set('elo', S.elo);
  showElo(); renderLog(); render();
  const diff = Math.round(S.rate - before);
  dialog(text, `<p>推定レート ${Math.round(before)} → ${Math.round(S.rate)}（${diff>=0?'+':''}${diff}）${S.auto?`<br>次の相手: ${S.elo}`:''}</p><button id="again" style="font-size:15px">次の対局</button>`);
  $('again').onclick = () => { closeDialog(); newGame(); };
}

const clampElo = v => Math.min(eloMax, Math.max(eloMin, v));

function renderLog(){
  $('log').innerHTML = S.hist.slice(0, 10).map(h =>
    `${h.t}　相手${h.opp}　${h.s===1?'○':h.s===0?'●':'△'}　→ ${h.r}`).join('<br>');
}

/* ---------- Input ---------- */
$('board').addEventListener('click', ev => {
  const sqEl = ev.target.closest('.sq'); if (!sqEl || over || thinking || !engineReady) return;
  if (game.turn() !== myColor) return;
  const name = sqEl.dataset.sq;
  const piece = game.get(name);
  if (selected) {
    const cand = game.moves({ square: selected, verbose: true }).filter(m => m.to === name);
    if (cand.length) {
      if (cand[0].promotion) { choosePromotion(cand[0].from, name); return; }
      doMove({ from: selected, to: name }); return;
    }
  }
  selected = (piece && piece.color === myColor && selected !== name) ? name : null;
  render();
});

function doMove(m){
  const r = game.move(m); lastMove = r; selected = null; save(); afterMove();
}

function choosePromotion(from, to){
  dialog('成る駒を選択', ['q','r','b','n'].map(p => `<button data-p="${p}">${GLYPH[p]}</button>`).join(''));
  $('dbody').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    closeDialog(); doMove({ from, to, promotion: b.dataset.p });
  };
}

function dialog(title, html){ $('dtitle').textContent = title; $('dbody').innerHTML = html; $('dbody').onclick = null; $('dialog').hidden = false; }
function closeDialog(){ $('dialog').hidden = true; }

/* ---------- Buttons ---------- */
$('elo').addEventListener('input', e => { S.elo = +e.target.value; store.set('elo', S.elo); showElo(); $('oppname').textContent = `相手: Stockfish ${S.elo}  ／  あなた: ${myColor==='w'?'白':'黒'}`; });
$('auto').onclick = () => { S.auto = !S.auto; store.set('auto', S.auto); showElo(); };
$('new').onclick = () => {
  if (!over && game.history().length > 0 && !confirm('現在の対局を破棄して新しく始めますか？')) return;
  waiter = null; newGame();
};
$('flip').onclick = () => { flipped = !flipped; render(); };
$('undo').onclick = () => {
  if (over || thinking) return;
  const n = game.turn() === myColor ? 2 : 1;
  for (let i=0;i<n;i++) game.undo();
  const h = game.history({ verbose: true }); lastMove = h.length ? h[h.length-1] : null;
  selected = null; save(); afterMove();
};
$('resign').onclick = () => { if (over || !confirm('投了しますか？')) return; waiter = null; thinking = false; finish('投了：あなたの負け', 0); };
$('hint').checked = S.hint;
$('hint').onchange = e => { S.hint = e.target.checked; store.set('hint', S.hint); render(); };
$('mt').value = String(S.mt);
$('mt').onchange = e => { S.mt = +e.target.value; store.set('mt', S.mt); };

/* ---------- Boot ---------- */
renderLog(); showElo();
startEngine();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
