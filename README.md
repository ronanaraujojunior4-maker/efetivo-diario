# Efetivo Diário — Masters (RH + SESMT)

Aplicativo web instalável (PWA) do Controle de Efetivo da Engenharia — Masters.
Desenvolvido por ESTERNAN Tecnologia e Sistemas · *Tecnologia com propósito*.

## Como funciona

- **Interface:** HTML, CSS e JavaScript puro (sem compilação). Funciona no celular e no computador e pode ser instalada como aplicativo.
- **Banco de dados:** Supabase (PostgreSQL), com regras de segurança (RLS) aplicadas no próprio banco.
- **Login:** por **nome de usuário e senha**, sem e-mail. As senhas do sistema anterior são migradas automaticamente no primeiro acesso.
- **Tempo real:** o Dashboard se atualiza sozinho quando alguém lança o efetivo.
- **Sem internet:** apontamentos feitos sem conexão ficam guardados no aparelho, marcados como "não sincronizados", e são enviados sozinhos quando a internet volta, sem duplicar.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Telas e estilos |
| `app.js` | Lógica do aplicativo |
| `config.js` | Endereço do projeto Supabase e chave **pública** (publishable) |
| `sw.js` | Funcionamento sem internet (guarda só os arquivos do app, nunca dados) |
| `manifest.webmanifest`, `icons/` | Instalação como aplicativo |

## Segurança

- `config.js` contém apenas valores públicos por natureza.
- **Nunca** coloque neste repositório a chave secreta (`sb_secret_…` ou `service_role`), senhas, o pepper das senhas antigas ou o código de sincronização.
- As permissões são conferidas no banco. Esconder um botão na interface não é a proteção: é só conveniência.

## Publicar uma nova versão

1. Altere os arquivos.
2. Aumente `versao` em `config.js` e `VERSAO_CACHE` em `sw.js`, com o mesmo número.
3. Envie ao GitHub. O GitHub Pages publica em cerca de 1 minuto.
