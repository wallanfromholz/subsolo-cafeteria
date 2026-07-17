/* Subsolo Café — sincronização de estado entre aparelhos (Vercel Serverless Function)
 *
 * Guarda o estado inteiro do app no Upstash Redis (marketplace da Vercel), cifrado com
 * AES-256-GCM. Escritas usam CAS ATÔMICO via script Lua (EVAL): a versão só avança se a
 * versão-base do cliente for a atual — duas edições simultâneas nunca se sobrescrevem;
 * quem perde recebe 409 com o estado vencedor para mesclar e reenviar.
 *
 * Variáveis de ambiente (injetadas pela integração Upstash KV + SYNC_SECRET própria):
 *   KV_REST_API_URL / KV_REST_API_TOKEN   (ou UPSTASH_REDIS_REST_URL / _TOKEN)
 *   SYNC_SECRET                           (chave da cifra do conteúdo)
 *
 * Ações (POST JSON):
 *   {acao:'status'}                          → {ok, temEstado, v}
 *   {acao:'pull', user, pass}                → login por usuário/e-mail + senha → {ok, v, estado, uid}
 *   {acao:'pull', uid, hash}                 → aparelho já sincronizado → {ok, v, estado}
 *   {acao:'push', uid|user..., baseV, estado}→ {ok, v} ou 409 {ok:false, conflito:true, v, estado}
 *   {acao:'signup', usuario}                 → cria conta PENDENTE (admin aprova no app)
 */
const crypto = require('crypto');

const K_V = 'subsolo:v';
const K_ESTADO = 'subsolo:estado';

const redisUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) { // executa um comando Redis via REST; devolve o campo result
  const r = await fetch(redisUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error('Redis: ' + ((j && j.error) || r.status));
  return j.result;
}

/* CAS atômico: grava v+pacote apenas se a versão atual for exatamente baseV */
const LUA_CAS = "local curv = tonumber(redis.call('GET', KEYS[1]) or '0') " +
  "if curv == tonumber(ARGV[1]) then " +
  "redis.call('SET', KEYS[1], ARGV[2]) redis.call('SET', KEYS[2], ARGV[3]) return -1 " +
  "else return curv end";

const chave = () => crypto.createHash('sha256').update('subsolo-sync|' + (process.env.SYNC_SECRET || '')).digest();
function cifrar(txt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const enc = Buffer.concat([c.update(txt, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decifrar(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const igual = (a, b) => {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

async function carregar() { // → {v, estado} ou null
  const res = await redis(['MGET', K_V, K_ESTADO]);
  const v = res && res[0] ? +res[0] : 0;
  if (!res || !res[1]) {
    // estado ausente: zera o contador para não travar todo push num CAS impossível
    if (v) { try { await redis(['DEL', K_V]); } catch (e) {} }
    return null;
  }
  if (!v) return null;
  return { v, estado: JSON.parse(decifrar(JSON.parse(res[1]).dados)) };
}
/* tenta gravar (v = baseV+1); devolve {venceu:true} ou {venceu:false, atual:{v, estado}} */
async function gravarCAS(baseV, estado) {
  const pacote = JSON.stringify({ em: Date.now(), dados: cifrar(JSON.stringify(estado)) });
  if (pacote.length > LIMITE_ESTADO) { const e = new Error('o histórico do café ficou grande demais para sincronizar'); e.grande = true; throw e; }
  const res = await redis(['EVAL', LUA_CAS, '2', K_V, K_ESTADO, String(baseV), String(baseV + 1), pacote]);
  if (+res === -1) return { venceu: true };
  return { venceu: false, atual: await carregar() };
}

/* autentica contra a lista de usuários de um estado (mesmo hash do app: sha256("salt::senha"))
   → {u} quando ok; {reAutenticar:true} quando o usuário existe mas a credencial é velha
   (senha trocada noutro aparelho) — assim o cliente pede login em vez de travar em erro. */
function autenticar(estado, body) {
  const us = (estado && estado.usuarios) || [];
  if (body.uid && body.hash) {
    const u = us.find(x => x.id === body.uid);
    if (!u) return {};
    if (u.ativo === false) return {};
    if (igual(u.hash, body.hash)) return { u };
    return { reAutenticar: true }; // hash local desatualizado
  }
  if (body.user && body.pass) {
    const login = String(body.user).trim().toLowerCase();
    const u = us.find(x => String(x.user).toLowerCase() === login || (x.email && String(x.email).toLowerCase() === login));
    if (!u || u.ativo === false) return {};
    return igual(u.hash, sha256hex((u.salt || '') + '::' + body.pass)) ? { u } : {};
  }
  return {};
}

/* o que um NÃO-admin pode alterar: tudo menos a equipe e as configurações.
   Impede que um garçom (editando o próprio aparelho) se promova ou mexa nos acessos dos outros. */
function sanearEnvio(atualEstado, novoEstado, autor) {
  if (autor.papel === 'admin') return novoEstado;
  const seguro = Object.assign({}, novoEstado);
  seguro.usuarios = atualEstado.usuarios;   // equipe só muda por admin
  seguro.config = atualEstado.config;       // permissões/preços/impostos só por admin
  return seguro;
}

/* limites leves por IP (melhor esforço por instância morna) */
function limitador(max, janelaMs) {
  const mapa = new Map();
  return (ip) => {
    const agora = Date.now();
    const arr = (mapa.get(ip) || []).filter(t => agora - t < janelaMs);
    if (arr.length >= max) { mapa.set(ip, arr); return false; }
    arr.push(agora); mapa.set(ip, arr);
    if (mapa.size > 1000) mapa.clear();
    return true;
  };
}
const podeSignup = limitador(3, 10 * 60 * 1000);
const podeTentarSenha = limitador(10, 10 * 60 * 1000); // brute force de senha no pull público
const ipDe = (req) => String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || 'desconhecido';
const LIMITE_ESTADO = 3 * 1024 * 1024; // ~3 MB de estado: acima disso o Redis/Vercel recusam

async function lerBody(req) {
  if (req.body !== undefined && req.body !== null) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const txt = Buffer.concat(chunks).toString('utf8');
  return txt ? JSON.parse(txt) : {};
}

module.exports = async (req, res) => {
  // 'agora' vai em toda resposta: é o relógio comum que os aparelhos usam para carimbar edições
  const responder = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Object.assign({ agora: Date.now() }, obj))); };
  if (req.method !== 'POST') return responder(405, { ok: false, erro: 'Use POST.' });
  if (!redisUrl() || !redisToken() || !process.env.SYNC_SECRET) return responder(503, { ok: false, erro: 'Sincronização não configurada (Redis/SYNC_SECRET).' });

  let body;
  try { body = await lerBody(req); } catch (e) { return responder(400, { ok: false, erro: 'Corpo inválido.' }); }
  const acao = body && body.acao;

  let atual;
  try { atual = await carregar(); }
  catch (e) { return responder(502, { ok: false, erro: 'Falha ao acessar o cofre: ' + e.message }); }

  if (acao === 'status') return responder(200, { ok: true, temEstado: !!atual, v: atual ? atual.v : 0 });

  if (acao === 'pull') {
    if (!atual) return responder(404, { ok: false, erro: 'Ainda não há dados sincronizados.' });
    if (body.pass && !podeTentarSenha(ipDe(req))) return responder(429, { ok: false, erro: 'Muitas tentativas — aguarde alguns minutos.' });
    const a = autenticar(atual.estado, body);
    if (a.reAutenticar) return responder(401, { ok: false, reAutenticar: true, erro: 'Credencial desatualizada — entre de novo.' });
    if (!a.u) return responder(401, { ok: false, erro: 'Usuário ou senha incorretos (ou acesso desativado).' });
    return responder(200, { ok: true, v: atual.v, estado: atual.estado, uid: a.u.id });
  }

  if (acao === 'signup') {
    // cria conta PENDENTE direto no servidor (aparelho novo, ninguém logado) — o admin aprova depois
    if (!atual) return responder(404, { ok: false, erro: 'Ainda não há sistema no servidor.' });
    if (!podeSignup(ipDe(req))) return responder(429, { ok: false, erro: 'Muitos cadastros — tente mais tarde.' });
    const u = body.usuario || {};
    const nome = String(u.nome || '').slice(0, 80).trim(), user = String(u.user || '').slice(0, 60).trim();
    const email = String(u.email || '').slice(0, 120).trim().toLowerCase();
    if (!nome || !user || !u.salt || !u.hash || !u.recSalt || !u.recHash) return responder(400, { ok: false, erro: 'Cadastro incompleto.' });
    for (let tent = 0; tent < 3; tent++) {
      const us = atual.estado.usuarios || [];
      if (us.filter(x => x.pendente && x.ativo === false).length >= 20) return responder(429, { ok: false, erro: 'Há cadastros demais aguardando aprovação.' });
      const colide = us.some(x => String(x.user).toLowerCase() === user.toLowerCase() ||
        (email && (String(x.email || '').toLowerCase() === email || String(x.user).toLowerCase() === email)) ||
        (x.email && String(x.email).toLowerCase() === user.toLowerCase()));
      if (colide) return responder(409, { ok: false, erro: 'Esse usuário ou e-mail já pertence a alguém da equipe.' });
      // id é gerado no SERVIDOR (nunca aceito do cliente) para não colidir/duplicar no merge
      const novo = { id: 'u_srv_' + crypto.randomBytes(8).toString('hex'), nome, user, email, papel: 'garcom',
        salt: String(u.salt), hash: String(u.hash), recSalt: String(u.recSalt), recHash: String(u.recHash),
        ativo: false, pendente: true, criadoEm: Date.now(), mEm: Date.now() };
      atual.estado.usuarios = [...us, novo];
      let g;
      try { g = await gravarCAS(atual.v, atual.estado); }
      catch (e) { return responder(502, { ok: false, erro: 'Falha ao gravar: ' + e.message }); }
      if (g.venceu) return responder(200, { ok: true, v: atual.v + 1, uid: novo.id });
      if (!g.atual) return responder(503, { ok: false, erro: 'Servidor ocupado — tente de novo.' });
      atual = g.atual; // perdeu a corrida: reaplica o cadastro sobre o vencedor
    }
    return responder(503, { ok: false, erro: 'Servidor ocupado — tente de novo.' });
  }

  if (acao === 'push') {
    const estado = body.estado;
    if (!estado || !Array.isArray(estado.usuarios)) return responder(400, { ok: false, erro: 'Estado inválido.' });
    if (atual) {
      const a = autenticar(atual.estado, body);
      if (a.reAutenticar) return responder(401, { ok: false, reAutenticar: true, erro: 'Credencial desatualizada — entre de novo.' });
      if (!a.u) return responder(401, { ok: false, erro: 'Sem autorização para gravar.' });
      const baseV = +body.baseV || 0;
      if (baseV !== atual.v) return responder(409, { ok: false, conflito: true, v: atual.v, estado: atual.estado });
      const limpo = sanearEnvio(atual.estado, estado, a.u);
      if (!limpo.usuarios.some(x => x.papel === 'admin' && x.ativo !== false)) return responder(400, { ok: false, erro: 'O estado precisa manter um administrador ativo.' });
      let g;
      try { g = await gravarCAS(baseV, limpo); }
      catch (e) { return responder(502, { ok: false, erro: 'Falha ao gravar: ' + e.message }); }
      if (!g.venceu) {
        if (!g.atual) return responder(503, { ok: false, erro: 'Servidor ocupado — tente de novo.' });
        return responder(409, { ok: false, conflito: true, v: g.atual.v, estado: g.atual.estado });
      }
      return responder(200, { ok: true, v: baseV + 1 });
    }
    // bootstrap: servidor vazio — o estado enviado precisa ter admin ativo e o auth deve bater com ele
    if (!estado.usuarios.some(x => x.papel === 'admin' && x.ativo !== false)) return responder(400, { ok: false, erro: 'O primeiro envio precisa ter um administrador ativo.' });
    const ab = autenticar(estado, body);
    if (!ab.u || ab.u.papel !== 'admin') return responder(401, { ok: false, erro: 'O primeiro envio deve ser feito por um administrador.' });
    let g;
    try { g = await gravarCAS(0, estado); }
    catch (e) { return responder(502, { ok: false, erro: 'Falha ao gravar: ' + e.message }); }
    if (!g.venceu) {
      if (!g.atual) return responder(503, { ok: false, erro: 'Servidor ocupado — tente de novo.' });
      return responder(409, { ok: false, conflito: true, v: g.atual.v, estado: g.atual.estado });
    }
    return responder(200, { ok: true, v: 1 });
  }

  return responder(400, { ok: false, erro: 'Ação desconhecida.' });
};
