# Subsolo Café · Gestão

Sistema de gestão do Sub Solo — Café Bristol: balcão/mesas, encomendas, produção, estoque, compras, caixa, clientes, precificação e equipe — tudo num arquivo só ([index.html](index.html)), com os dados guardados no próprio aparelho (localStorage).

## Publicação (Vercel)

O site é estático; a Vercel serve o `index.html` e a função [api/reset.js](api/reset.js) automaticamente, sem build. Todo `git push` na branch `main` gera um novo deploy.

## Acessos e papéis

- **Primeiro acesso** cria o administrador (com nome, e-mail, usuário e senha).
- Em **Equipe & Acessos** (menu Sistema, só admin) você cadastra cada pessoa com papel **Administrador**, **Caixa** ou **Garçom**, e marca nos checkboxes o que cada papel enxerga.
- Quem chega pela tela de login pode **Criar conta**, mas ela nasce **aguardando aprovação** — só entra depois que um administrador libera em Equipe & Acessos.
- Cada pessoa recebe um **código de recuperação** na criação — entregue para ela guardar.

## Sincronização entre aparelhos

Todos os aparelhos compartilham os mesmos dados: o caixa lança uma venda e o garçom vê na hora; uma encomenda feita no computador aparece no celular. Cada pessoa entra com o próprio acesso, em quantos aparelhos quiser, ao mesmo tempo.

Como funciona: o estado do café fica no **Upstash Redis** (integração da Vercel), cifrado com AES-256-GCM, e a função [api/estado.js](api/estado.js) faz o meio de campo. Os aparelhos enviam suas mudanças e conferem novidades a cada 4 segundos (na hora, ao voltar para a aba).

- **Duas pessoas editando ao mesmo tempo:** cada entidade (pedido, cliente, insumo…) carrega o horário da última alteração e o merge une os dois lados — a versão mais recente vence por item, então ninguém sobrescreve o trabalho do outro. Gravações concorrentes usam CAS atômico (Lua/`EVAL`), então nunca se perdem.
- **Movimentações de caixa** são unidas por id: uma sangria no balcão e um recebimento no celular coexistem no mesmo dia.
- **Sem internet:** o app continua funcionando e salvando no aparelho; ao voltar o sinal, ele mescla e sobe sozinho. O rodapé mostra o estado (`☁️ sincronizado`, `☁️ sincronizando…`, `⚠ sem conexão`).
- **Permissões no servidor:** quem não é administrador não consegue alterar a equipe nem as configurações, mesmo mexendo no próprio aparelho.

Variáveis necessárias (a integração Upstash cria as primeiras sozinha): `KV_REST_API_URL`, `KV_REST_API_TOKEN` e `SYNC_SECRET` (uma frase longa e aleatória, criada por você). Sem elas, o app volta a funcionar só no aparelho, como antes.

**Backup:** com a sincronização ligada, o backup (Início → Backup) é uma **cópia de segurança** — não é mais o jeito de levar dados de um aparelho a outro. Restaurar um backup substitui os dados de **toda a equipe**.

### Histórico e restauração (rollback)

Em **Configurações → Backup → 🕘 Histórico e restauração** (só admin), você vê pontos de restauração do café ao longo do tempo e volta a qualquer um deles com um clique.

- O servidor guarda um ponto automático conforme o café é usado (no máximo um a cada ~10 min) e você pode **salvar um ponto manual** antes de algo arriscado (ex.: um balanço de estoque).
- **Restaurar** volta *tudo* a como estava naquele momento, em **todos os aparelhos** — e o estado atual vira um ponto novo, então dá para **desfazer** a restauração.
- Guarda os últimos 60 pontos automáticos e 30 manuais.

## "Esqueci minha senha" por e-mail (Resend)

O envio usa a função `/api/reset` + o serviço [Resend](https://resend.com). Para ativar:

1. **Crie uma conta no Resend** (grátis: 100 e-mails/dia, 3.000/mês).
2. **Verifique seu domínio** em *Resend → Domains* (ex.: `subsolocafe.com.br`, criando os registros DNS que eles pedem). Sem domínio verificado o Resend só envia para o e-mail do dono da conta — bom para testar, insuficiente para a equipe.
3. **Crie uma API Key** em *Resend → API Keys*.
4. Na **Vercel → Settings → Environment Variables**, adicione:
   | Variável | Valor | Obrigatória |
   |---|---|---|
   | `RESEND_API_KEY` | a chave criada no passo 3 | sim |
   | `RESET_FROM` | `Subsolo Café <acesso@seudominio.com.br>` (remetente no domínio verificado) | recomendada |
   | `RESET_SECRET` | qualquer frase longa aleatória (assina os códigos) | opcional |
5. **Redeploy** na Vercel (Deployments → ⋯ → Redeploy) para as variáveis valerem.
6. No app, em **Equipe & Acessos → E-mail de redefinição**, use o botão **Enviar e-mail de teste** para validar o ciclo completo.

Enquanto o e-mail não estiver configurado, o "esqueci minha senha" continua funcionando pelo **código de recuperação** de cada pessoa, e o administrador pode **redefinir a senha** de qualquer um na tela de Equipe.

A função tem um limite de envio embutido (5 códigos por IP e 30 no total a cada 10 minutos, por instância) para evitar abuso do endpoint público; os códigos valem por 15 minutos.

## Desenvolvimento local

Abra o `index.html` num servidor estático qualquer (`python3 -m http.server`). A função de e-mail só roda na Vercel (ou via `vercel dev`); localmente o app cai no fallback de código de recuperação automaticamente.
