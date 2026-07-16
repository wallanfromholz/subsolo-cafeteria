# Subsolo Café · Gestão

Sistema de gestão do Sub Solo — Café Bristol: balcão/mesas, encomendas, produção, estoque, compras, caixa, clientes, precificação e equipe — tudo num arquivo só ([index.html](index.html)), com os dados guardados no próprio aparelho (localStorage).

## Publicação (Vercel)

O site é estático; a Vercel serve o `index.html` e a função [api/reset.js](api/reset.js) automaticamente, sem build. Todo `git push` na branch `main` gera um novo deploy.

## Acessos e papéis

- **Primeiro acesso** cria o administrador (com nome, e-mail, usuário e senha).
- Em **Equipe & Acessos** (menu Sistema, só admin) você cadastra cada pessoa com papel **Administrador**, **Caixa** ou **Garçom**, e marca nos checkboxes o que cada papel enxerga.
- Cada pessoa recebe um **código de recuperação** na criação — entregue para ela guardar.
- **Importante:** os dados (inclusive os acessos) vivem no navegador de cada aparelho. Use o backup (Início → Backup) para levar tudo de um aparelho a outro.

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
