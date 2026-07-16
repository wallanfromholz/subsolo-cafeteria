/* Subsolo Café — redefinição de senha por e-mail (Vercel Serverless Function)
 *
 * Variáveis de ambiente necessárias (Vercel → Settings → Environment Variables):
 *   RESEND_API_KEY  (obrigatória) — chave da API do Resend (resend.com)
 *   RESET_FROM      (recomendada) — remetente verificado, ex.: "Subsolo Café <acesso@seudominio.com.br>"
 *   RESET_SECRET    (opcional)    — segredo próprio para assinar os códigos; se ausente, deriva da RESEND_API_KEY
 *
 * Fluxo stateless: 'enviar' manda um código de 6 dígitos por e-mail e devolve um token
 * assinado (HMAC) com o hash do código + validade; 'verificar' confere código × token.
 * Nenhum dado fica armazenado no servidor.
 */
const crypto = require('crypto');

const VALIDADE_MIN = 15;
const segredo = () => process.env.RESET_SECRET || crypto.createHash('sha256').update('subsolo|' + (process.env.RESEND_API_KEY || '')).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', segredo()).update(s).digest('hex');
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');
const igual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/* rate limit em memória (melhor esforço por instância morna): 5 envios/IP e 30 no total a cada 10 min */
const JANELA_MS = 10 * 60 * 1000;
const porIP = new Map();
let enviosGlobais = [];
function podeEnviar(ip) {
  const agora = Date.now();
  enviosGlobais = enviosGlobais.filter(t => agora - t < JANELA_MS);
  if (enviosGlobais.length >= 30) return false;
  const arr = (porIP.get(ip) || []).filter(t => agora - t < JANELA_MS);
  if (arr.length >= 5) { porIP.set(ip, arr); return false; }
  arr.push(agora); porIP.set(ip, arr); enviosGlobais.push(agora);
  if (porIP.size > 1000) porIP.clear();
  return true;
}

function emailHTML(nome, codigo) {
  const saudacao = nome ? `Olá, ${nome}!` : 'Olá!';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F4EBDA;font-family:Georgia,'Times New Roman',serif">
  <div style="max-width:460px;margin:0 auto;padding:32px 20px">
    <div style="background:#FBF5E9;border:1px solid #DCCBAA;border-radius:14px;padding:28px 26px;text-align:center">
      <div style="font-size:22px;letter-spacing:6px;color:#4E1826;font-weight:700">SUB SOLO</div>
      <div style="font-size:10px;letter-spacing:4px;color:#A87F3C;margin-bottom:22px">— CAFÉ BRISTOL —</div>
      <div style="font-size:15px;color:#2A1118;margin-bottom:6px">${saudacao}</div>
      <div style="font-size:13.5px;color:#6B5148;line-height:1.5;margin-bottom:20px">
        Recebemos um pedido para redefinir sua senha no sistema de gestão.<br>
        Use o código abaixo — ele vale por <b>${VALIDADE_MIN} minutos</b>.</div>
      <div style="font-family:Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:#4E1826;background:#EDE0C8;border:1.5px dashed #A87F3C;border-radius:12px;padding:16px 8px;margin-bottom:20px">${codigo}</div>
      <div style="font-size:12px;color:#9A8378;line-height:1.5">Se não foi você quem pediu, pode ignorar este e-mail —<br>sua senha continua a mesma.</div>
    </div>
    <div style="text-align:center;font-size:11px;color:#9A8378;margin-top:14px">Subsolo Café · e-mail automático, não precisa responder</div>
  </div></body></html>`;
}

async function lerBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const txt = Buffer.concat(chunks).toString('utf8');
  return txt ? JSON.parse(txt) : {};
}

module.exports = async (req, res) => {
  const responder = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return responder(405, { ok: false, erro: 'Use POST.' });

  let body;
  try { body = await lerBody(req); }
  catch (e) { return responder(400, { ok: false, erro: 'Corpo da requisição inválido.' }); }

  const acao = body && body.acao;

  if (acao === 'enviar') {
    if (!process.env.RESEND_API_KEY) return responder(503, { ok: false, erro: 'Envio de e-mail não configurado (falta RESEND_API_KEY na Vercel).' });
    const email = String(body.email || '').trim().toLowerCase();
    const nome = String(body.nome || '').replace(/[<>&"]/g, '').slice(0, 80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return responder(400, { ok: false, erro: 'E-mail inválido.' });
    const ip = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || 'desconhecido';
    if (!podeEnviar(ip)) return responder(429, { ok: false, erro: 'Muitos pedidos de código — aguarde alguns minutos e tente de novo.' });

    const codigo = String(crypto.randomInt(100000, 1000000));
    const exp = Date.now() + VALIDADE_MIN * 60 * 1000;

    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESET_FROM || 'Subsolo Café <onboarding@resend.dev>',
          to: [email],
          subject: `${codigo} é seu código — Subsolo Café`,
          html: emailHTML(nome, codigo)
        })
      });
    } catch (e) { return responder(502, { ok: false, erro: 'Não consegui falar com o serviço de e-mail.' }); }
    if (!r.ok) {
      let det = ''; try { const j = await r.json(); det = j && j.message ? ` (${j.message})` : ''; } catch (e) {}
      return responder(502, { ok: false, erro: 'O serviço de e-mail recusou o envio.' + det });
    }

    const payload = b64u(JSON.stringify({ e: email, h: hmac(codigo + '|' + email), x: exp }));
    return responder(200, { ok: true, token: payload + '.' + hmac(payload) });
  }

  if (acao === 'verificar') {
    const token = String(body.token || ''), codigo = String(body.codigo || '').trim();
    const [payload, assinatura] = token.split('.');
    if (!payload || !assinatura || !igual(hmac(payload), assinatura)) return responder(400, { ok: false, erro: 'Pedido de redefinição inválido — recomece o processo.' });
    let dados;
    try { dados = JSON.parse(unb64u(payload)); }
    catch (e) { return responder(400, { ok: false, erro: 'Pedido de redefinição inválido — recomece o processo.' }); }
    if (!dados.x || Date.now() > dados.x) return responder(400, { ok: false, erro: 'O código expirou — peça um novo.' });
    if (!/^\d{6}$/.test(codigo) || !igual(hmac(codigo + '|' + dados.e), dados.h)) return responder(400, { ok: false, erro: 'Código incorreto — confira no e-mail.' });
    return responder(200, { ok: true });
  }

  return responder(400, { ok: false, erro: 'Ação desconhecida.' });
};
