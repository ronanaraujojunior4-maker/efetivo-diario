/* =====================================================================
 * EFETIVO DIÁRIO — MASTERS · aplicativo (PWA) · v1.0.0
 * Login por USUÁRIO + SENHA (migração transparente), RH: Dashboard em tempo real, Efetivo Diário
 * (grupo/individual, funciona sem internet), Funcionários, Obras, Equipes, Transferências, Usuários.
 * Segurança: todas as regras e permissões são conferidas no banco (RLS + funções). A interface só esconde o que
 * o perfil não pode usar.
 * ===================================================================== */
(function () {
  'use strict';
  var CFG = window.EFETIVO_CONFIG;
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'efetivo-masters-auth' }
  });
  var SITUACOES = [['PRESENTE', 'Presente'], ['FALTA', 'Falta'], ['ATRASADO', 'Atrasado'], ['ATESTADO', 'Atestado'],
    ['FOLGA', 'Folga'], ['FÉRIAS', 'Férias'], ['AFASTADO', 'Afastado']];
  var ROTULO_SIT = {}; SITUACOES.forEach(function (s) { ROTULO_SIT[s[0]] = s[1]; });
  var INATIVIDADE_MIN = 30;

  var S = { usuario: null, perms: [], ambiente: 'RH', pagina: 'inicio', canal: null, timer: null, cache: {} };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style') e.setAttribute('style', v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
    (filhos || []).forEach(function (f) { if (f == null || f === false) return; e.appendChild(typeof f === 'string' || typeof f === 'number' ? document.createTextNode(String(f)) : f); });
    return e;
  }
  function limpar(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function pode(p) { return S.perms.indexOf(p) >= 0; }
  function hojeISO() { var d = new Date(), z = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  function dataBR(iso) { if (!iso) return ''; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function dataHoraBR(ts) { if (!ts) return '—'; var d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
  function chave(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function novoId() { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function toast(texto, tipo) {
    var t = $('toast'); limpar(t);
    var m = el('p', { class: 'msg ' + (tipo || 'ok'), text: texto, style: 'box-shadow:0 6px 24px rgba(0,0,0,.18)' });
    t.appendChild(m); clearTimeout(toast._t); toast._t = setTimeout(function () { limpar(t); }, 4500);
  }
  function mostrarMsg(id, texto, tipo) { var m = $(id); m.textContent = texto; m.className = 'msg ' + (tipo || 'er'); m.hidden = !texto; }
  function erroTexto(e) {
    var m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Erro');
    if (/SEM_PERMISSAO/.test(m)) return 'Seu perfil não permite esta ação.';
    if (/duplicate key|unique/i.test(m)) {
      if (/funcionarios_matricula/.test(m)) return 'Já existe funcionário com essa matrícula.';
      if (/funcionarios_nome/.test(m)) return 'Já existe funcionário com esse nome.';
      if (/obras_/.test(m)) return 'Já existe uma obra com esse código ou nome.';
      if (/equipes_/.test(m)) return 'Já existe uma equipe com esse nome.';
      return 'Registro duplicado.';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet.';
    return m.replace(/^(Error|Exception):\s*/, '');
  }
  function falhaRede(e) { return !navigator.onLine || /Failed to fetch|NetworkError|Load failed|fetch/i.test(String(e && (e.message || e))); }
  async function rpc(nome, args) { var r = await sb.rpc(nome, args || {}); if (r.error) throw r.error; return r.data; }
  async function consulta(q) { var r = await q; if (r.error) throw r.error; return r.data; }
  function guardar(k, v) { try { localStorage.setItem('efetivo-' + k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } }
  function ler(k) { try { return JSON.parse(localStorage.getItem('efetivo-' + k) || 'null'); } catch (e) { return null; } }
  function selecao(opcoes, valor, attrs) {
    var s = el('select', attrs || {});
    opcoes.forEach(function (o) { var op = el('option', { value: o[0], text: o[1] }); if (String(o[0]) === String(valor == null ? '' : valor)) op.selected = true; s.appendChild(op); });
    return s;
  }

  /* ---------------- fila offline (IndexedDB) ---------------- */
  var IDB = null;
  function abrirIDB() {
    if (IDB) return Promise.resolve(IDB);
    return new Promise(function (ok, falha) {
      try {
        var r = indexedDB.open('efetivo-masters', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('fila', { keyPath: 'id' }); };
        r.onsuccess = function () { IDB = r.result; ok(IDB); };
        r.onerror = function () { falha(r.error); };
      } catch (e) { falha(e); }
    });
  }
  function filaOp(modo, fn) {
    return abrirIDB().then(function (db) {
      return new Promise(function (ok, falha) {
        var tx = db.transaction('fila', modo), st = tx.objectStore('fila'), res;
        var req = fn(st); if (req) req.onsuccess = function () { res = req.result; };
        tx.oncomplete = function () { ok(res); }; tx.onerror = function () { falha(tx.error); };
      });
    });
  }
  function filaListar() { return filaOp('readonly', function (st) { return st.getAll(); }).then(function (l) { return (l || []).filter(function (x) { return S.usuario && x.dono === S.usuario.auth_id; }); }); }
  function filaGuardar(item) { return filaOp('readwrite', function (st) { return st.put(item); }); }
  function filaRemover(id) { return filaOp('readwrite', function (st) { return st.delete(id); }); }
  async function atualizarSeloFila() {
    var l = []; try { l = await filaListar(); } catch (e) { /* sem IndexedDB */ }
    var s = $('filaSelo'), erros = l.filter(function (x) { return x.erro; }).length;
    s.hidden = !l.length;
    s.className = 'selo ' + (erros ? 'er' : 'av');
    s.textContent = erros ? (erros + ' com problema') : (l.length + ' não sincronizado(s)');
    return l;
  }
  var sincronizando = false;
  async function sincronizarFila() {
    if (sincronizando || !navigator.onLine || !S.usuario) return;
    sincronizando = true;
    try {
      var l = await filaListar(), enviados = 0;
      for (var i = 0; i < l.length; i++) {
        var it = l[i]; if (it.erro) continue;
        try {
          await rpc('salvar_chamada', { p_obra: it.obra_id, p_data: it.data, p_itens: it.itens, p_substituir: it.substituir,
            p_lote: it.lote, p_origem: 'offline', p_versao: CFG.versao });
          await filaRemover(it.id); enviados++;
        } catch (e) {
          if (falhaRede(e)) break;
          it.erro = erroTexto(e); await filaGuardar(it);
        }
      }
      if (enviados) toast(enviados + ' apontamento(s) feito(s) sem internet foram enviados.', 'ok');
    } catch (e) { /* tenta depois */ }
    sincronizando = false;
    atualizarSeloFila();
  }

  /* ---------------- conexão ---------------- */
  function atualizarConexao() {
    var c = $('conexao'); var on = navigator.onLine;
    c.className = 'selo ' + (on ? 'ok' : 'av'); c.textContent = on ? '● Online' : '● Sem internet';
    if (on) sincronizarFila();
  }
  window.addEventListener('online', atualizarConexao);
  window.addEventListener('offline', atualizarConexao);

  /* ---------------- acesso ---------------- */
  function emailTecnico(login) { return login + '@' + CFG.dominioLogin; }
  function validarLogin(u) { var v = String(u || '').trim().toLowerCase(); return /^[a-z0-9._-]{4,30}$/.test(v) ? v : null; }
  async function chamarConta(corpo) {
    var r = await fetch(CFG.supabaseUrl + '/functions/v1/conta', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseKey }, body: JSON.stringify(corpo)
    });
    var j = {}; try { j = await r.json(); } catch (e) { j = { ok: false, mensagem: 'Resposta inválida do servidor.' }; }
    j.http = r.status; return j;
  }
  function telaAcesso(qual, msg) {
    $('app').hidden = true; $('ambientes').hidden = true; $('acesso').hidden = false;
    $('fLogin').hidden = qual !== 'login'; $('fPrimeiro').hidden = qual !== 'primeiro'; $('fRecuperar').hidden = qual !== 'recuperar';
    $('lkLogin').hidden = qual === 'login'; $('lkPrimeiro').hidden = qual === 'primeiro'; $('lkRecuperar').hidden = qual === 'recuperar';
    if (qual === 'login') { mostrarMsg('lgMsg', msg || '', 'er'); setTimeout(function () { $('lgUsuario').focus(); }, 50); }
  }
  document.querySelectorAll('[data-ver]').forEach(function (b) {
    b.addEventListener('click', function () { var i = $(b.getAttribute('data-ver')); var v = i.type === 'password'; i.type = v ? 'text' : 'password'; b.textContent = v ? 'Ocultar' : 'Mostrar'; });
  });
  $('lkLogin').onclick = function () { telaAcesso('login'); };
  $('lkPrimeiro').onclick = function () { $('paUsuario').value = $('lgUsuario').value.trim(); telaAcesso('primeiro'); };
  $('lkRecuperar').onclick = function () { $('reUsuario').value = $('lgUsuario').value.trim(); telaAcesso('recuperar'); };

  $('fLogin').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var login = validarLogin($('lgUsuario').value), senha = $('lgSenha').value, b = $('lgBtn');
    if (!login || !senha) { mostrarMsg('lgMsg', 'Informe o nome de usuário e a senha.'); return; }
    if (!navigator.onLine) { mostrarMsg('lgMsg', 'Sem internet. Para entrar pela primeira vez é preciso estar conectado.', 'av'); return; }
    b.disabled = true; mostrarMsg('lgMsg', 'Verificando…', 'av');
    try {
      var r = await sb.auth.signInWithPassword({ email: emailTecnico(login), password: senha });
      if (r.error) {
        if (/rate limit|too many/i.test(r.error.message)) throw new Error('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
        // Conta ainda não migrada (ou senha errada): o servidor confere a senha do sistema anterior.
        var m = await chamarConta({ acao: 'migrar', usuario: login, senha: senha });
        if (!m.ok) throw new Error(m.mensagem || 'Usuário ou senha incorretos, ou acesso desativado.');
        r = await sb.auth.signInWithPassword({ email: emailTecnico(login), password: senha });
        if (r.error) throw new Error('Não foi possível concluir o acesso. Tente novamente.');
      }
      $('lgSenha').value = '';
      await aposLogin(true);
    } catch (e) {
      $('lgSenha').value = '';
      mostrarMsg('lgMsg', erroTexto(e), 'er');
    } finally { b.disabled = false; }
  });

  $('fPrimeiro').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var u = validarLogin($('paUsuario').value), s = $('paSenha').value, c = $('paConf').value;
    if (!u) { mostrarMsg('paMsg', 'Informe um nome de usuário válido.'); return; }
    mostrarMsg('paMsg', 'Criando sua senha…', 'av');
    try {
      var r = await chamarConta({ acao: 'primeiro_acesso', usuario: u, senha: s, confirmacao: c });
      if (!r.ok) throw new Error(r.mensagem);
      $('paSenha').value = ''; $('paConf').value = '';
      $('lgUsuario').value = u; telaAcesso('login'); mostrarMsg('lgMsg', r.mensagem, 'ok');
    } catch (e) { mostrarMsg('paMsg', erroTexto(e)); }
  });

  $('fRecuperar').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var u = validarLogin($('reUsuario').value);
    if (!u) { mostrarMsg('reMsg', 'Informe um nome de usuário válido.'); return; }
    mostrarMsg('reMsg', 'Redefinindo…', 'av');
    try {
      var r = await chamarConta({ acao: 'recuperar', usuario: u, codigo: $('reCodigo').value.trim(), senha: $('reSenha').value, confirmacao: $('reConf').value });
      if (!r.ok) throw new Error(r.mensagem);
      ['reCodigo', 'reSenha', 'reConf'].forEach(function (i) { $(i).value = ''; });
      $('lgUsuario').value = u; telaAcesso('login'); mostrarMsg('lgMsg', r.mensagem, 'ok');
    } catch (e) { mostrarMsg('reMsg', erroTexto(e)); }
  });

  async function aposLogin(registrar) {
    var perfil;
    if (registrar) {
      perfil = await rpc('registrar_acesso');
      if (!perfil || !perfil.ok) {
        await sb.auth.signOut();
        throw new Error(perfil && perfil.motivo === 'desativado' ? 'Este acesso está desativado. Fale com o ADM.' : 'Conta sem cadastro no sistema. Fale com o ADM.');
      }
    }
    var sess = (await sb.auth.getSession()).data.session;
    if (!sess) throw new Error('Sessão não iniciada.');
    try {
      var u = await consulta(sb.from('usuarios').select('id,nome,usuario_login,perfil_codigo,ativo,perfis(nome)').eq('auth_id', sess.user.id).maybeSingle());
      if (!u || !u.ativo) { await sb.auth.signOut(); throw new Error('Este acesso está desativado. Fale com o ADM.'); }
      var perms = await rpc('minhas_permissoes');
      S.usuario = { id: u.id, auth_id: sess.user.id, nome: u.nome, usuario: u.usuario_login, perfil: u.perfil_codigo, perfilNome: (u.perfis && u.perfis.nome) || u.perfil_codigo };
      S.perms = (perms || []).map(function (x) { return typeof x === 'string' ? x : (x.minhas_permissoes || Object.values(x)[0]); });
      guardar('perfil', { usuario: S.usuario, perms: S.perms });
    } catch (e) {
      if (!falhaRede(e)) throw e;
      var c = ler('perfil'); // sem internet: usa o último perfil conhecido deste aparelho
      if (!c || !c.usuario || c.usuario.auth_id !== sess.user.id) throw e;
      S.usuario = c.usuario; S.perms = c.perms || [];
    }
    tocarSessao();
    var temSESMT = S.perms.some(function (p) { return /^sesmt\./.test(p); }) || S.usuario.perfil === 'ADM';
    if (temSESMT) mostrarAmbientes(); else entrarNoApp('RH');
  }
  function mostrarAmbientes() {
    $('acesso').hidden = true; $('app').hidden = true; $('ambientes').hidden = false;
    $('ambNome').textContent = S.usuario.nome; $('ambPerfil').textContent = 'Perfil ' + S.usuario.perfilNome;
  }
  $('ambRH').onclick = function () { entrarNoApp('RH'); };
  $('ambSESMT').onclick = function () { entrarNoApp('SESMT'); };
  document.querySelectorAll('#ambTroca button').forEach(function (b) { b.onclick = function () { entrarNoApp(b.getAttribute('data-amb')); }; });
  document.querySelectorAll('[data-sair]').forEach(function (b) { b.onclick = function () { sair('Você saiu do sistema.'); }; });

  async function sair(msg) {
    clearTimeout(S.timer);
    if (S.canal) { try { sb.removeChannel(S.canal); } catch (e) { /* ignora */ } S.canal = null; }
    try { await sb.auth.signOut(); } catch (e) { /* sem internet: encerra localmente */ }
    S.usuario = null; S.perms = [];
    telaAcesso('login', '');
    if (msg) mostrarMsg('lgMsg', msg, 'av');
  }
  function tocarSessao() { clearTimeout(S.timer); if (S.usuario) S.timer = setTimeout(function () { sair('Sessão encerrada por inatividade.'); }, INATIVIDADE_MIN * 60000); }
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function () { if (S.usuario) tocarSessao(); }, true); });

  /* ---------------- navegação ---------------- */
  var PAGINAS_RH = [
    ['inicio', 'Início', 'dashboard.ver', pgDashboard],
    ['efetivo', 'Efetivo Diário', 'efetivo.ver', pgEfetivo],
    ['funcionarios', 'Funcionários', 'funcionarios.ver', pgFuncionarios],
    ['obras', 'Obras', 'obras.ver', pgObras],
    ['equipes', 'Equipes', 'equipes.ver', pgEquipes],
    ['transferencias', 'Transferências', 'transferencias.ver', pgTransferencias],
    ['relatorios', 'Relatórios', 'relatorios.ver', pgRelatorios],
    ['usuarios', 'Usuários e acessos', 'usuarios.gerenciar', pgUsuarios],
    ['config', 'Configurações', null, pgConfig]
  ];
  function paginasPermitidas() { return PAGINAS_RH.filter(function (p) { return !p[2] || pode(p[2]); }); }
  function entrarNoApp(amb) {
    S.ambiente = amb;
    $('acesso').hidden = true; $('ambientes').hidden = true; $('app').hidden = false;
    $('topoNome').textContent = S.usuario.nome; $('topoPerfil').textContent = S.usuario.perfilNome; $('versao').textContent = 'v' + CFG.versao;
    document.querySelectorAll('#ambTroca button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-amb') === amb ? 'true' : 'false'); });
    $('ambTroca').hidden = !(S.usuario.perfil === 'ADM' || S.perms.some(function (p) { return /^sesmt\./.test(p); }));
    atualizarConexao(); atualizarSeloFila(); ligarTempoReal();
    if (amb === 'SESMT') { montarMenu([]); return pgSESMT(); }
    var p = paginasPermitidas(); montarMenu(p);
    var alvo = (location.hash || '').replace('#', '');
    irPara(p.some(function (x) { return x[0] === alvo; }) ? alvo : (p[0] ? p[0][0] : 'config'));
  }
  function montarMenu(paginas) {
    var m = limpar($('menu'));
    paginas.forEach(function (p) {
      m.appendChild(el('button', { type: 'button', 'data-p': p[0], text: p[1], onclick: function () { irPara(p[0]); } }));
    });
  }
  function irPara(id) {
    var p = paginasPermitidas().filter(function (x) { return x[0] === id; })[0] || paginasPermitidas()[0];
    S.pagina = p[0];
    document.querySelectorAll('#menu button').forEach(function (b) { if (b.getAttribute('data-p') === p[0]) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('menu').classList.remove('aberto'); $('menuBtn').setAttribute('aria-expanded', 'false');
    try { history.replaceState(null, '', '#' + p[0]); } catch (e) { /* ignora */ }
    document.title = p[1] + ' — Efetivo Diário Masters';
    var c = limpar($('conteudo'));
    c.appendChild(el('p', { class: 'nota', text: 'Carregando…' }));
    Promise.resolve(p[3](c)).catch(function (e) { limpar(c); c.appendChild(el('p', { class: 'msg er', text: erroTexto(e) })); });
    window.scrollTo(0, 0);
  }
  $('menuBtn').onclick = function () { var m = $('menu'), a = !m.classList.contains('aberto'); m.classList.toggle('aberto', a); this.setAttribute('aria-expanded', a ? 'true' : 'false'); };

  /* ---------------- tempo real ---------------- */
  var recarregarAgendado = null;
  function ligarTempoReal() {
    if (S.canal) return;
    S.canal = sb.channel('efetivo-mudancas')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'registros_diarios' }, aoMudar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'funcionarios' }, aoMudar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'obras' }, aoMudar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transferencias' }, aoMudar)
      .subscribe(function (status) { S.aoVivo = status === 'SUBSCRIBED'; var a = $('aoVivo'); if (a) pintarAoVivo(a); });
  }
  function aoMudar() {
    clearTimeout(recarregarAgendado);
    recarregarAgendado = setTimeout(function () {
      if (S.pagina === 'inicio' && S.recarregarDashboard) S.recarregarDashboard(true);
      if (S.pagina === 'transferencias' && S.recarregarTransf) S.recarregarTransf();
    }, 600);
  }
  function pintarAoVivo(a) {
    a.className = 'ao-vivo' + (S.aoVivo ? '' : ' off');
    a.textContent = S.aoVivo ? '● Atualizando em tempo real' + (S.ultimaAtualizacao ? ' · atualizado às ' + S.ultimaAtualizacao : '') : '● Conectando à atualização automática…';
  }

  /* ---------------- dados comuns ---------------- */
  async function carregarBase(forcar) {
    if (!forcar && S.cache.base && Date.now() - S.cache.base.em < 30000) return S.cache.base;
    try {
      var r = await Promise.all([
        consulta(sb.from('funcionarios').select('id,matricula,nome,funcao_texto,profissao_id,admissao,situacao,pendencias').order('nome')),
        consulta(sb.from('obras').select('id,codigo,nome,responsavel,situacao').order('nome')),
        consulta(sb.from('equipes').select('id,nome,obra_id,situacao').order('nome'))
      ]);
      S.cache.base = { funcionarios: r[0], obras: r[1], equipes: r[2], em: Date.now() };
      guardar('base', S.cache.base);
    } catch (e) {
      if (!falhaRede(e)) throw e;
      var c = ler('base'); if (!c) throw new Error('Sem internet e sem dados guardados neste aparelho. Conecte-se uma vez para carregar.');
      S.cache.base = c; S.cache.base.offline = true;
    }
    return S.cache.base;
  }
  function nomeObra(o) { return o ? ((o.codigo ? o.codigo + ' — ' : '') + o.nome) : 'Obra não identificada'; }

  /* ================= PÁGINA: DASHBOARD ================= */
  async function pgDashboard(c) {
    var dataI = el('input', { type: 'date', value: S.dashData || hojeISO() });
    var obraS = el('select', {});
    var aoVivo = el('p', { id: 'aoVivo', class: 'ao-vivo' }); pintarAoVivo(aoVivo);
    var kpis = el('div', { class: 'kpis' }), tabela = el('div', { class: 'tw' }), barras = el('div'), sits = el('div', { class: 'acoes' });
    limpar(c);
    c.appendChild(el('div', { class: 'cab' }, [
      el('div', {}, [el('h1', { class: 'tit', text: 'Dashboard de Efetivo' }), aoVivo]),
      el('div', { class: 'filtros' }, [el('label', {}, ['Data', dataI]), el('label', {}, ['Obra', obraS])])
    ]));
    c.appendChild(kpis);
    c.appendChild(el('div', { class: 'duas' }, [
      el('section', { class: 'card' }, [el('h2', { text: 'Efetivo por obra', style: 'margin-bottom:10px' }), tabela]),
      el('section', { class: 'card' }, [el('h2', { text: 'Presentes por obra', style: 'margin-bottom:10px' }), barras,
        el('h2', { text: 'Distribuição por situação', style: 'margin:14px 0 10px' }), sits])
    ]));

    async function carregar(silencioso) {
      S.dashData = dataI.value || hojeISO();
      var base = await carregarBase(!silencioso ? false : true);
      if (!obraS.options.length) {
        obraS.appendChild(el('option', { value: '', text: 'Todas as obras' }));
        base.obras.filter(function (o) { return o.situacao === 'ativa'; }).forEach(function (o) { obraS.appendChild(el('option', { value: o.id, text: nomeObra(o) })); });
      }
      var regs = await consulta(sb.from('registros_diarios').select('funcionario_id,status,obra_id').eq('data', S.dashData).is('excluido_em', null));
      // mesma regra do sistema atual: só funcionários ativos; 1 registro por funcionário/dia
      var ativos = {}, mapaO = {}; base.funcionarios.forEach(function (f) { if (f.situacao !== 'inativo') ativos[f.id] = 1; });
      base.obras.forEach(function (o) { mapaO[o.id] = o; });
      var porF = {}; regs.forEach(function (r) { if (!ativos[r.funcionario_id]) return; if (obraS.value && r.obra_id !== obraS.value) return; porF[r.funcionario_id] = r; });
      var lista = Object.keys(porF).map(function (k) { return porF[k]; });
      var pres = 0, falt = 0, atr = 0, porObra = {}, porSit = {}, obrasEf = {};
      lista.forEach(function (r) {
        if (r.status === 'PRESENTE') pres++; else if (r.status === 'FALTA') falt++;
        if (r.status === 'ATRASADO') atr++;
        porSit[r.status] = (porSit[r.status] || 0) + 1;
        var k = r.obra_id || '-'; porObra[k] = porObra[k] || { obra: mapaO[r.obra_id], total: 0, pres: 0, falt: 0 };
        porObra[k].total++; if (r.status === 'PRESENTE' || r.status === 'ATRASADO') porObra[k].pres++; if (r.status === 'FALTA') porObra[k].falt++;
        if ((r.status === 'PRESENTE' || r.status === 'ATRASADO') && mapaO[r.obra_id]) obrasEf[r.obra_id] = 1;
      });
      limpar(kpis);
      [['Funcionários ativos', Object.keys(ativos).length, lista.length + ' com registro no dia', ''],
       ['Presentes', pres, 'atrasados: ' + atr + ' (contam como efetivo)', 'color:#394086'],
       ['Faltas', falt, 'no dia', 'color:#b00e0e'],
       ['Outras situações', lista.length - pres - falt, 'atrasado, atestado, folga, férias, afastado', ''],
       ['Obras com efetivo', Object.keys(obrasEf).length, 'de ' + base.obras.length + ' obras cadastradas', '']
      ].forEach(function (k) { kpis.appendChild(el('div', { class: 'card kpi' }, [el('small', { text: k[0] }), el('b', { text: k[1], style: k[3] }), el('small', { text: k[2], style: 'font-weight:400' })])); });

      var linhas = Object.keys(porObra).map(function (k) { return porObra[k]; }).sort(function (a, b) { return b.total - a.total; });
      limpar(tabela); limpar(barras); limpar(sits);
      if (!linhas.length) { tabela.appendChild(el('p', { class: 'nota', text: 'Nenhum registro para esta data e filtro.' })); }
      else {
        var tb = el('tbody');
        linhas.forEach(function (l) { tb.appendChild(el('tr', {}, [el('td', { text: nomeObra(l.obra) }), el('td', { text: (l.obra && l.obra.responsavel) || '' }), el('td', { class: 'num', text: l.pres, style: 'font-weight:700' }), el('td', { class: 'num', text: l.falt }), el('td', { class: 'num', text: l.total })])); });
        tabela.appendChild(el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: 'Obra' }), el('th', { text: 'Responsável' }), el('th', { class: 'num', text: 'Presentes' }), el('th', { class: 'num', text: 'Faltas' }), el('th', { class: 'num', text: 'Registros' })])]), tb]));
        var max = Math.max.apply(null, linhas.map(function (l) { return l.pres; }).concat([1]));
        linhas.filter(function (l) { return l.pres > 0; }).forEach(function (l) {
          barras.appendChild(el('div', { class: 'barra' }, [el('span', { text: ((l.obra && l.obra.nome) || '—') + ' · ' + l.pres }), el('i', { style: 'width:' + Math.max(2, Math.round(l.pres / max * 100)) + '%', 'aria-hidden': 'true' })]));
        });
      }
      Object.keys(porSit).forEach(function (s) { sits.appendChild(el('span', { class: 'selo ne', style: 'font-size:13px;padding:6px 12px', text: (ROTULO_SIT[s] || s) + ' ' + porSit[s] })); });
      if (!Object.keys(porSit).length) sits.appendChild(el('p', { class: 'nota', text: 'Nenhuma situação registrada nesta data.' }));
      S.ultimaAtualizacao = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); pintarAoVivo(aoVivo);
    }
    dataI.onchange = function () { carregar(); }; obraS.onchange = function () { carregar(); };
    S.recarregarDashboard = function (forcar) { carregar(forcar).catch(function () { /* mantém a tela */ }); };
    await carregar();
  }

  /* ================= PÁGINA: EFETIVO DIÁRIO ================= */
  async function pgEfetivo(c) {
    var base = await carregarBase();
    var podeLancar = pode('efetivo.lancar');
    var obras = base.obras.filter(function (o) { return o.situacao === 'ativa'; });
    var ativos = base.funcionarios.filter(function (f) { return f.situacao === 'ativo'; });
    var equipes = base.equipes.filter(function (e) { return e.situacao === 'ativa'; });
    var obraS = selecao([['', 'Selecione a obra']].concat(obras.map(function (o) { return [o.id, nomeObra(o)]; })), S.efObra || '');
    var dataI = el('input', { type: 'date', value: S.efData || hojeISO() });
    var modo = S.efModo || 'grupo';
    var bG = el('button', { type: 'button', text: 'Em grupo (chamada da obra)' }), bI = el('button', { type: 'button', text: 'Individual' });
    var area = el('div', { style: 'display:grid;gap:12px' });
    limpar(c);
    c.appendChild(el('div', { class: 'cab' }, [el('h1', { class: 'tit', text: 'Efetivo Diário' }),
      el('div', { class: 'filtros' }, [el('label', {}, ['Obra', obraS]), el('label', {}, ['Data', dataI])])]));
    if (base.offline) c.appendChild(el('p', { class: 'msg av', text: 'Sem internet: usando os cadastros guardados neste aparelho. O que for salvo agora será enviado automaticamente quando a conexão voltar.' }));
    c.appendChild(el('div', { class: 'modo', role: 'group', 'aria-label': 'Modo de apontamento' }, [bG, bI]));
    c.appendChild(area);
    function pintarModo() { bG.setAttribute('aria-pressed', modo === 'grupo' ? 'true' : 'false'); bI.setAttribute('aria-pressed', modo === 'individual' ? 'true' : 'false'); }
    bG.onclick = function () { modo = S.efModo = 'grupo'; pintarModo(); carregar(); };
    bI.onclick = function () { modo = S.efModo = 'individual'; pintarModo(); carregar(); };
    obraS.onchange = function () { S.efObra = obraS.value; carregar(); };
    dataI.onchange = function () { S.efData = dataI.value; carregar(); };
    pintarModo();

    async function registrosDoDia() {
      try { return await consulta(sb.from('registros_diarios').select('id,funcionario_id,status,obra_id,observacao,atividade,equipe_id').eq('data', dataI.value).is('excluido_em', null)); }
      catch (e) { if (falhaRede(e)) return null; throw e; }
    }
    function botoesSituacao(atual, aoEscolher) {
      var box = el('div', { class: 'ops', role: 'group', 'aria-label': 'Situação' });
      SITUACOES.forEach(function (s) {
        var b = el('button', { type: 'button', text: s[1], 'aria-pressed': atual === s[0] ? 'true' : 'false' });
        b.onclick = function () { box.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); b.setAttribute('aria-pressed', 'true'); aoEscolher(s[0]); };
        if (!podeLancar) b.disabled = true;
        box.appendChild(b);
      });
      return box;
    }
    async function enviar(obraId, itens, substituir, lote, rotulo) {
      var pacote = { id: novoId(), dono: S.usuario.auth_id, obra_id: obraId, obra_nome: rotulo, data: dataI.value, itens: itens, substituir: substituir, lote: lote, criado_em: new Date().toISOString() };
      if (!navigator.onLine) { await filaGuardar(pacote); await atualizarSeloFila(); return { offline: true }; }
      try {
        var r = await rpc('salvar_chamada', { p_obra: obraId, p_data: dataI.value, p_itens: itens, p_substituir: substituir, p_lote: lote, p_origem: 'app', p_versao: CFG.versao });
        return r;
      } catch (e) {
        if (falhaRede(e)) { await filaGuardar(pacote); await atualizarSeloFila(); return { offline: true }; }
        throw e;
      }
    }

    async function carregar() {
      limpar(area);
      if (!obraS.value) { area.appendChild(el('p', { class: 'nota', text: 'Selecione a obra e a data.' })); return; }
      area.appendChild(el('p', { class: 'nota', text: 'Carregando…' }));
      var regs = await registrosDoDia(); limpar(area);
      if (regs === null) area.appendChild(el('p', { class: 'msg av', text: 'Sem internet: não foi possível ver o que já foi lançado nesta data. Você pode lançar; o envio acontece quando a conexão voltar.' }));
      regs = regs || [];
      var daObra = {}, outra = {}, mapaO = {};
      obras.forEach(function (o) { mapaO[o.id] = o; }); base.obras.forEach(function (o) { mapaO[o.id] = o; });
      regs.forEach(function (r) { if (r.obra_id === obraS.value) daObra[r.funcionario_id] = r; else outra[r.funcionario_id] = r; });
      if (modo === 'grupo') montarGrupo(daObra, outra, mapaO); else montarIndividual(daObra, outra, mapaO);
    }

    function montarGrupo(daObra, outra, mapaO) {
      var estado = ativos.map(function (f) {
        var r = daObra[f.id];
        return { f: f, incluido: !!r, status: r ? r.status : '', atividade: r ? (r.atividade || '') : '', equipe_id: r ? (r.equipe_id || '') : '', observacao: r ? (r.observacao || '') : '', bloqueio: outra[f.id] ? mapaO[outra[f.id].obra_id] : null };
      });
      var eqS = selecao([['', 'Sem equipe']].concat(equipes.map(function (e) { return [e.id, e.nome]; })), '');
      var atvI = el('textarea', { rows: '2', placeholder: 'Descreva a atividade executada (texto livre)' });
      var busca = el('input', { type: 'search', placeholder: 'Pesquisar por nome ou matrícula' });
      var aplicar = el('button', { type: 'button', class: 'btn sec min', text: 'Aplicar aos marcados' });
      var todosP = el('button', { type: 'button', class: 'btn sec min', text: 'Marcar todos como Presente' });
      var lista = el('ul', { class: 'lista' });
      var contador = el('b'), salvarB = el('button', { type: 'button', class: 'btn', text: 'Salvar chamada' }), aviso = el('p', { class: 'nota', role: 'status' });
      area.appendChild(el('div', { class: 'grupoBox' }, [el('label', {}, ['Equipe', eqS]), el('label', {}, ['Atividade executada', atvI]),
        el('div', { class: 'acoes', style: 'align-self:end' }, [aplicar, todosP])]));
      area.appendChild(busca);
      area.appendChild(lista);
      area.appendChild(el('div', { class: 'rodapeFixo' }, [el('span', {}, [contador, ' funcionário(s) na chamada']), aviso, salvarB]));
      if (!podeLancar) { salvarB.disabled = true; aplicar.disabled = true; todosP.disabled = true; aviso.textContent = 'Seu perfil pode consultar, mas não lançar.'; }
      function contar() { contador.textContent = estado.filter(function (e) { return e.incluido; }).length; }
      function pintar() {
        limpar(lista); var t = chave(busca.value);
        estado.forEach(function (e) {
          if (t && chave(e.f.nome + ' ' + (e.f.matricula || '')).indexOf(t) < 0) return;
          var li = el('li', { class: 'pessoa' + (e.incluido ? '' : ' fora') });
          var chk = el('input', { type: 'checkbox' }); chk.checked = e.incluido; chk.disabled = !podeLancar || !!e.bloqueio;
          chk.onchange = function () { e.incluido = chk.checked; if (e.incluido && !e.status) e.status = 'PRESENTE'; contar(); pintar(); };
          li.appendChild(el('label', { class: 'lin' }, [chk, el('span', { class: 'nm' }, [el('b', { text: e.f.nome }), el('small', { text: (e.f.matricula || 's/ matrícula') + ' · ' + (e.f.funcao_texto || '') })])]));
          if (e.bloqueio) { li.appendChild(el('p', { class: 'msg av', text: 'Já registrado em outra obra nesta data: ' + nomeObra(e.bloqueio) })); }
          else if (e.incluido) {
            li.appendChild(botoesSituacao(e.status, function (s) { e.status = s; }));
            var det = el('details', {}, [el('summary', { text: 'Atividade, equipe e observação deste funcionário', style: 'font-size:13px;color:#394086;cursor:pointer;min-height:32px' })]);
            var a = el('input', { value: e.atividade, placeholder: 'Atividade (se diferente do grupo)' }); a.oninput = function () { e.atividade = a.value; };
            var q = selecao([['', 'Equipe do grupo']].concat(equipes.map(function (x) { return [x.id, x.nome]; })), e.equipe_id); q.onchange = function () { e.equipe_id = q.value; };
            var o = el('input', { value: e.observacao, placeholder: 'Observação (opcional)' }); o.oninput = function () { e.observacao = o.value; };
            det.appendChild(el('div', { class: 'extra' }, [a, q, o]));
            li.appendChild(det);
          }
          lista.appendChild(li);
        });
        contar();
      }
      busca.oninput = pintar;
      aplicar.onclick = function () { estado.forEach(function (e) { if (e.incluido) { if (atvI.value.trim()) e.atividade = atvI.value.trim(); if (eqS.value) e.equipe_id = eqS.value; } }); pintar(); toast('Atividade e equipe aplicadas aos marcados. Cada um ainda pode ser ajustado.', 'ok'); };
      todosP.onclick = function () { estado.forEach(function (e) { if (!e.bloqueio) { e.incluido = true; e.status = e.status || 'PRESENTE'; } }); pintar(); };
      salvarB.onclick = async function () {
        var sel = estado.filter(function (e) { return e.incluido; });
        if (sel.some(function (e) { return !e.status; })) { toast('Selecione a situação de todos os funcionários incluídos.', 'er'); return; }
        var removidos = estado.filter(function (e) { return !e.incluido && daObra[e.f.id]; }).length;
        if (!confirm('Salvar a chamada de ' + sel.length + ' funcionário(s) em ' + obraS.options[obraS.selectedIndex].text + ' — ' + dataBR(dataI.value) + '?' +
          (removidos ? '\n\n' + removidos + ' funcionário(s) desmarcado(s) terão o registro desta obra/data marcado como excluído (o histórico é preservado).' : ''))) return;
        salvarB.disabled = true; aviso.textContent = 'Salvando…';
        var itens = sel.map(function (e) { return { funcionario_id: e.f.id, status: e.status, observacao: e.observacao || '', atividade: e.atividade || atvI.value.trim(), equipe_id: e.equipe_id || eqS.value || '', client_uuid: novoId(), registrado_em: new Date().toISOString() }; });
        var lote = (atvI.value.trim() || eqS.value) ? { atividade: atvI.value.trim(), equipe_id: eqS.value, client_uuid: novoId() } : null;
        try {
          var r = await enviar(obraS.value, itens, true, lote, obraS.options[obraS.selectedIndex].text);
          if (r.offline) { aviso.textContent = 'Sem internet: chamada guardada neste aparelho e marcada como NÃO SINCRONIZADA. Será enviada sozinha.'; toast('Guardado no aparelho. Será enviado quando a internet voltar.', 'av'); }
          else { aviso.textContent = r.mensagem + ' Novos: ' + r.novos + ' · alterados: ' + r.alterados + ' · excluídos: ' + r.excluidos + '.'; toast(r.mensagem, 'ok'); await carregar(); }
        } catch (e) { aviso.textContent = ''; toast(erroTexto(e), 'er'); }
        finally { salvarB.disabled = !podeLancar; }
      };
      pintar();
    }

    function montarIndividual(daObra, outra, mapaO) {
      var funcS = selecao([['', 'Selecione o funcionário']].concat(ativos.map(function (f) { return [f.id, f.nome + (f.matricula ? ' (' + f.matricula + ')' : '')]; })), '');
      var info = el('div'), status = '';
      var atv = el('textarea', { rows: '2', placeholder: 'Atividade executada (texto livre)' });
      var eq = selecao([['', 'Sem equipe']].concat(equipes.map(function (x) { return [x.id, x.nome]; })), '');
      var obs = el('input', { placeholder: 'Observação (opcional)' });
      var sitBox = el('div');
      var salvarB = el('button', { type: 'button', class: 'btn', text: 'Salvar apontamento' });
      area.appendChild(el('div', { class: 'card', style: 'display:grid;gap:12px' }, [el('label', {}, ['Funcionário', funcS]), info,
        el('div', {}, [el('p', { class: 'nota', text: 'Situação' }), sitBox]),
        el('div', { class: 'form' }, [el('label', {}, ['Atividade', atv]), el('label', {}, ['Equipe', eq]), el('label', {}, ['Observação', obs])]), salvarB]));
      salvarB.disabled = !podeLancar;
      function pintarSit() { limpar(sitBox).appendChild(botoesSituacao(status, function (s) { status = s; })); }
      funcS.onchange = function () {
        limpar(info); var id = funcS.value, r = daObra[id], o = outra[id];
        status = r ? r.status : 'PRESENTE'; atv.value = r ? (r.atividade || '') : ''; eq.value = r ? (r.equipe_id || '') : ''; obs.value = r ? (r.observacao || '') : '';
        if (r) info.appendChild(el('p', { class: 'msg ok', text: 'Já registrado nesta obra hoje como ' + (ROTULO_SIT[r.status] || r.status) + '. Salvar altera o registro.' }));
        if (o) info.appendChild(el('p', { class: 'msg av', text: 'Já registrado em outra obra nesta data: ' + nomeObra(mapaO[o.obra_id]) + '. Corrija lá antes.' }));
        salvarB.disabled = !podeLancar || !!o || !id;
        pintarSit();
      };
      pintarSit();
      salvarB.onclick = async function () {
        if (!funcS.value) { toast('Selecione o funcionário.', 'er'); return; }
        salvarB.disabled = true;
        try {
          var r = await enviar(obraS.value, [{ funcionario_id: funcS.value, status: status, atividade: atv.value.trim(), equipe_id: eq.value, observacao: obs.value.trim(), client_uuid: novoId(), registrado_em: new Date().toISOString() }], false, null, obraS.options[obraS.selectedIndex].text);
          if (r.offline) toast('Sem internet: apontamento guardado no aparelho e marcado como não sincronizado.', 'av');
          else { toast('Apontamento salvo.', 'ok'); await carregar(); }
        } catch (e) { toast(erroTexto(e), 'er'); }
        finally { salvarB.disabled = !podeLancar; }
      };
    }
    await carregar();
  }

  /* ================= PÁGINA: FUNCIONÁRIOS ================= */
  async function pgFuncionarios(c) {
    var base = await carregarBase(true), podeEditar = pode('funcionarios.editar');
    var profs = await consulta(sb.from('profissoes').select('id,nome').order('nome'));
    var busca = el('input', { type: 'search', placeholder: 'Pesquisar por nome, matrícula ou função' });
    var filtro = selecao([['ativo', 'Ativos'], ['inativo', 'Inativos'], ['', 'Todos']], 'ativo');
    var form = el('div', { class: 'card', hidden: true }), tabela = el('div', { class: 'tw' }), hist = el('div');
    var novo = el('button', { type: 'button', class: 'btn', text: 'Adicionar funcionário' }); novo.hidden = !podeEditar;
    limpar(c);
    c.appendChild(el('div', { class: 'cab' }, [el('h1', { class: 'tit', text: 'Funcionários' }), novo]));
    c.appendChild(el('div', { class: 'filtros' }, [el('label', { style: 'flex:1;min-width:240px' }, ['Pesquisar', busca]), el('label', {}, ['Situação', filtro])]));
    c.appendChild(form); c.appendChild(hist);
    c.appendChild(el('section', { class: 'card' }, [tabela]));
    var dl = el('datalist', { id: 'dlProf' }); profs.forEach(function (p) { dl.appendChild(el('option', { value: p.nome })); }); c.appendChild(dl);

    function abrirForm(f) {
      limpar(form); form.hidden = false;
      var nome = el('input', { value: f ? f.nome : '', required: true }), mat = el('input', { value: f ? (f.matricula || '') : '', inputmode: 'numeric' });
      var fun = el('input', { value: f ? (f.funcao_texto || '') : '', list: 'dlProf' }), adm = el('input', { type: 'date', value: f && f.admissao ? f.admissao : '' });
      var msg = el('p', { class: 'msg er', hidden: true });
      var salvar = el('button', { type: 'button', class: 'btn', text: 'Salvar' }), cancelar = el('button', { type: 'button', class: 'btn sec', text: 'Cancelar' });
      form.appendChild(el('h2', { text: f ? 'Editar funcionário' : 'Novo funcionário', style: 'margin-bottom:12px' }));
      form.appendChild(el('div', { class: 'form' }, [el('label', {}, ['Nome completo *', nome]), el('label', {}, ['Matrícula', mat]), el('label', {}, ['Função', fun]), el('label', {}, ['Admissão', adm])]));
      form.appendChild(el('div', { class: 'acoes', style: 'margin-top:12px' }, [salvar, cancelar])); form.appendChild(msg);
      cancelar.onclick = function () { form.hidden = true; };
      salvar.onclick = async function () {
        var n = nome.value.replace(/\s+/g, ' ').trim(); if (!n) { msg.hidden = false; msg.textContent = 'Informe o nome completo.'; return; }
        salvar.disabled = true;
        try {
          var funcao = fun.value.replace(/\s+/g, ' ').trim(), profId = null;
          if (funcao) {
            var p = profs.filter(function (x) { return chave(x.nome) === chave(funcao); })[0];
            if (!p) { p = await consulta(sb.from('profissoes').insert({ nome: funcao }).select('id,nome').single()); profs.push(p); }
            profId = p.id;
          }
          var dados = { nome: n, matricula: mat.value.trim() || null, funcao_texto: funcao || null, profissao_id: profId, admissao: adm.value || null };
          if (f) await consulta(sb.from('funcionarios').update(dados).eq('id', f.id));
          else await consulta(sb.from('funcionarios').insert(dados));
          form.hidden = true; toast(f ? 'Funcionário atualizado.' : 'Funcionário cadastrado.', 'ok');
          base = await carregarBase(true); pintar();
        } catch (e) { msg.hidden = false; msg.textContent = erroTexto(e); }
        finally { salvar.disabled = false; }
      };
      nome.focus(); form.scrollIntoView({ behavior: 'smooth' });
    }
    async function historico(f) {
      limpar(hist);
      var box = el('section', { class: 'card' }, [el('h2', { text: 'Histórico de ' + f.nome, style: 'margin-bottom:8px' }), el('p', { class: 'nota', text: 'Carregando…' })]);
      hist.appendChild(box); box.scrollIntoView({ behavior: 'smooth' });
      var mapaO = {}; base.obras.forEach(function (o) { mapaO[o.id] = o; });
      var regs = await consulta(sb.from('registros_diarios').select('data,status,obra_id,atividade,excluido_em,motivo_exclusao').eq('funcionario_id', f.id).order('data', { ascending: false }).limit(120));
      box.removeChild(box.lastChild);
      if (!regs.length) { box.appendChild(el('p', { class: 'nota', text: 'Sem registros.' })); return; }
      var tb = el('tbody');
      regs.forEach(function (r) { tb.appendChild(el('tr', { style: r.excluido_em ? 'opacity:.55' : '' }, [el('td', { text: dataBR(r.data) }), el('td', { text: (ROTULO_SIT[r.status] || r.status) + (r.excluido_em ? ' (excluído: ' + (r.motivo_exclusao || '') + ')' : '') }), el('td', { text: r.obra_id ? nomeObra(mapaO[r.obra_id]) : '' }), el('td', { text: r.atividade || '' })])); });
      box.appendChild(el('div', { class: 'tw' }, [el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: 'Data' }), el('th', { text: 'Situação' }), el('th', { text: 'Obra' }), el('th', { text: 'Atividade' })])]), tb])]));
      box.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Fechar histórico', style: 'margin-top:10px', onclick: function () { limpar(hist); } }));
    }
    function pintar() {
      var t = chave(busca.value), tb = el('tbody'), n = 0;
      base.funcionarios.forEach(function (f) {
        if (filtro.value && f.situacao !== filtro.value) return;
        if (t && chave(f.nome + ' ' + (f.matricula || '') + ' ' + (f.funcao_texto || '')).indexOf(t) < 0) return;
        n++;
        var acoes = el('div', { class: 'acoes' });
        acoes.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Histórico', onclick: function () { historico(f).catch(function (e) { toast(erroTexto(e), 'er'); }); } }));
        if (podeEditar) {
          acoes.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Editar', onclick: function () { abrirForm(f); } }));
          var inat = f.situacao === 'inativo';
          acoes.appendChild(el('button', { type: 'button', class: 'btn min ' + (inat ? 'sec' : 'perigo'), text: inat ? 'Reativar' : 'Inativar', onclick: async function () {
            if (!confirm((inat ? 'Reativar ' : 'Inativar ') + f.nome + '? O histórico é sempre preservado.')) return;
            try { await consulta(sb.from('funcionarios').update({ situacao: inat ? 'ativo' : 'inativo' }).eq('id', f.id)); base = await carregarBase(true); pintar(); toast('Situação atualizada.', 'ok'); } catch (e) { toast(erroTexto(e), 'er'); }
          } }));
        }
        tb.appendChild(el('tr', {}, [el('td', { text: f.nome }), el('td', { text: f.matricula || '' }), el('td', { text: f.funcao_texto || '' }), el('td', { text: f.admissao ? dataBR(f.admissao) : '' }),
          el('td', {}, [el('span', { class: 'selo ' + (f.situacao === 'ativo' ? 'ok' : 'ne'), text: f.situacao })]), el('td', { text: f.pendencias || '', style: 'font-size:13px;color:#8a5a00' }), el('td', {}, [acoes])]));
      });
      limpar(tabela);
      tabela.appendChild(el('p', { class: 'nota', text: n + ' funcionário(s)', style: 'margin-bottom:8px' }));
      tabela.appendChild(el('table', {}, [el('thead', {}, [el('tr', {}, ['Nome', 'Matrícula', 'Função', 'Admissão', 'Situação', 'Pendências', ''].map(function (h) { return el('th', { text: h }); }))]), tb]));
    }
    busca.oninput = pintar; filtro.onchange = pintar; novo.onclick = function () { abrirForm(null); };
    pintar();
  }

  /* ================= PÁGINA: OBRAS ================= */
  async function pgObras(c) {
    var base = await carregarBase(true), podeEditar = pode('obras.editar');
    var busca = el('input', { type: 'search', placeholder: 'Pesquisar por código, nome ou responsável' });
    var form = el('div', { class: 'card', hidden: true }), tabela = el('div', { class: 'tw' });
    var novo = el('button', { type: 'button', class: 'btn', text: 'Adicionar obra' }); novo.hidden = !podeEditar;
    limpar(c);
    c.appendChild(el('div', { class: 'cab' }, [el('h1', { class: 'tit', text: 'Obras' }), novo]));
    c.appendChild(busca); c.appendChild(form); c.appendChild(el('section', { class: 'card' }, [tabela]));
    function abrirForm(o) {
      limpar(form); form.hidden = false;
      var cod = el('input', { value: o ? (o.codigo || '') : '' }), nome = el('input', { value: o ? o.nome : '' }), resp = el('input', { value: o ? (o.responsavel || '') : '' });
      var sit = selecao([['ativa', 'Ativa'], ['inativa', 'Inativa']], o ? o.situacao : 'ativa');
      var msg = el('p', { class: 'msg er', hidden: true }), salvar = el('button', { type: 'button', class: 'btn', text: 'Salvar' });
      form.appendChild(el('h2', { text: o ? 'Editar obra' : 'Nova obra', style: 'margin-bottom:12px' }));
      form.appendChild(el('div', { class: 'form' }, [el('label', {}, ['Código', cod]), el('label', {}, ['Nome da obra *', nome]), el('label', {}, ['Responsável', resp]), el('label', {}, ['Situação', sit])]));
      form.appendChild(el('div', { class: 'acoes', style: 'margin-top:12px' }, [salvar, el('button', { type: 'button', class: 'btn sec', text: 'Cancelar', onclick: function () { form.hidden = true; } })])); form.appendChild(msg);
      salvar.onclick = async function () {
        var n = nome.value.replace(/\s+/g, ' ').trim(); if (!n) { msg.hidden = false; msg.textContent = 'Informe o nome da obra.'; return; }
        salvar.disabled = true;
        try {
          var d = { codigo: cod.value.trim() || null, nome: n, responsavel: resp.value.trim() || null, situacao: sit.value };
          if (o) await consulta(sb.from('obras').update(d).eq('id', o.id)); else await consulta(sb.from('obras').insert(d));
          form.hidden = true; toast(o ? 'Obra atualizada.' : 'Obra cadastrada.', 'ok'); base = await carregarBase(true); pintar();
        } catch (e) { msg.hidden = false; msg.textContent = erroTexto(e); } finally { salvar.disabled = false; }
      };
    }
    function pintar() {
      var t = chave(busca.value), tb = el('tbody');
      base.obras.forEach(function (o) {
        if (t && chave((o.codigo || '') + ' ' + o.nome + ' ' + (o.responsavel || '')).indexOf(t) < 0) return;
        var acoes = el('div', { class: 'acoes' });
        if (podeEditar) acoes.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Editar', onclick: function () { abrirForm(o); } }));
        tb.appendChild(el('tr', {}, [el('td', { text: o.codigo || '' }), el('td', { text: o.nome }), el('td', { text: o.responsavel || '' }), el('td', {}, [el('span', { class: 'selo ' + (o.situacao === 'ativa' ? 'ok' : 'ne'), text: o.situacao })]), el('td', {}, [acoes])]));
      });
      limpar(tabela).appendChild(el('table', {}, [el('thead', {}, [el('tr', {}, ['Código', 'Nome da obra', 'Responsável', 'Situação', ''].map(function (h) { return el('th', { text: h }); }))]), tb]));
    }
    busca.oninput = pintar; novo.onclick = function () { abrirForm(null); }; pintar();
  }

  /* ================= PÁGINA: EQUIPES ================= */
  async function pgEquipes(c) {
    var base = await carregarBase(true), podeEditar = pode('equipes.editar');
    var obras = base.obras.filter(function (o) { return o.situacao === 'ativa'; }), mapaO = {}; base.obras.forEach(function (o) { mapaO[o.id] = o; });
    var form = el('div', { class: 'card', hidden: true }), tabela = el('div', { class: 'tw' });
    var novo = el('button', { type: 'button', class: 'btn', text: 'Cadastrar equipe' }); novo.hidden = !podeEditar;
    limpar(c);
    c.appendChild(el('div', { class: 'cab' }, [el('h1', { class: 'tit', text: 'Equipes' }), novo]));
    c.appendChild(el('p', { class: 'nota', text: 'As equipes cadastradas aparecem para seleção no Efetivo Diário.' }));
    c.appendChild(form); c.appendChild(el('section', { class: 'card' }, [tabela]));
    function abrirForm(eq) {
      limpar(form); form.hidden = false;
      var nome = el('input', { value: eq ? eq.nome : '' }), ob = selecao([['', 'Todas as obras']].concat(obras.map(function (o) { return [o.id, nomeObra(o)]; })), eq ? eq.obra_id : '');
      var sit = selecao([['ativa', 'Ativa'], ['inativa', 'Inativa']], eq ? eq.situacao : 'ativa');
      var msg = el('p', { class: 'msg er', hidden: true }), salvar = el('button', { type: 'button', class: 'btn', text: 'Salvar' });
      form.appendChild(el('div', { class: 'form' }, [el('label', {}, ['Nome da equipe *', nome]), el('label', {}, ['Obra (opcional)', ob]), el('label', {}, ['Situação', sit])]));
      form.appendChild(el('div', { class: 'acoes', style: 'margin-top:12px' }, [salvar, el('button', { type: 'button', class: 'btn sec', text: 'Cancelar', onclick: function () { form.hidden = true; } })])); form.appendChild(msg);
      salvar.onclick = async function () {
        var n = nome.value.replace(/\s+/g, ' ').trim(); if (!n) { msg.hidden = false; msg.textContent = 'Informe o nome.'; return; }
        salvar.disabled = true;
        try {
          var d = { nome: n, obra_id: ob.value || null, situacao: sit.value };
          if (eq) await consulta(sb.from('equipes').update(d).eq('id', eq.id)); else await consulta(sb.from('equipes').insert(d));
          form.hidden = true; toast('Equipe salva.', 'ok'); base = await carregarBase(true); pintar();
        } catch (e) { msg.hidden = false; msg.textContent = erroTexto(e); } finally { salvar.disabled = false; }
      };
    }
    function pintar() {
      var tb = el('tbody');
      base.equipes.forEach(function (eq) {
        tb.appendChild(el('tr', {}, [el('td', { text: eq.nome }), el('td', { text: eq.obra_id ? nomeObra(mapaO[eq.obra_id]) : 'Todas' }), el('td', {}, [el('span', { class: 'selo ' + (eq.situacao === 'ativa' ? 'ok' : 'ne'), text: eq.situacao })]),
          el('td', {}, [podeEditar ? el('button', { type: 'button', class: 'btn sec min', text: 'Editar', onclick: function () { abrirForm(eq); } }) : null])]));
      });
      limpar(tabela);
      if (!base.equipes.length) tabela.appendChild(el('p', { class: 'nota', text: 'Nenhuma equipe cadastrada ainda.' }));
      else tabela.appendChild(el('table', {}, [el('thead', {}, [el('tr', {}, ['Equipe', 'Obra', 'Situação', ''].map(function (h) { return el('th', { text: h }); }))]), tb]));
    }
    novo.onclick = function () { abrirForm(null); }; pintar();
  }

  /* ================= PÁGINA: TRANSFERÊNCIAS ================= */
  async function pgTransferencias(c) {
    var base = await carregarBase(), podeLancar = pode('transferencias.lancar');
    var mapaO = {}, mapaF = {}; base.obras.forEach(function (o) { mapaO[o.id] = o; }); base.funcionarios.forEach(function (f) { mapaF[f.id] = f; });
    var tabela = el('div', { class: 'tw' }), form = el('div', { class: 'card', hidden: !podeLancar });
    limpar(c);
    c.appendChild(el('h1', { class: 'tit', text: 'Transferências entre obras' }));
    if (podeLancar) {
      var fS = selecao([['', 'Funcionário']].concat(base.funcionarios.filter(function (f) { return f.situacao === 'ativo'; }).map(function (f) { return [f.id, f.nome]; })), '');
      var dS = selecao([['', 'Obra de destino']].concat(base.obras.filter(function (o) { return o.situacao === 'ativa'; }).map(function (o) { return [o.id, nomeObra(o)]; })), '');
      var dt = el('input', { type: 'date', value: hojeISO() }), ob = el('input', { placeholder: 'Observação (opcional)' }), b = el('button', { type: 'button', class: 'btn', text: 'Registrar transferência' });
      form.appendChild(el('div', { class: 'form' }, [el('label', {}, ['Funcionário', fS]), el('label', {}, ['Destino', dS]), el('label', {}, ['Data', dt]), el('label', {}, ['Observação', ob])]));
      form.appendChild(el('div', { style: 'margin-top:12px' }, [b]));
      b.onclick = async function () {
        if (!fS.value || !dS.value) { toast('Selecione o funcionário e a obra de destino.', 'er'); return; }
        b.disabled = true;
        try { await rpc('registrar_transferencia', { p_funcionario: fS.value, p_destino: dS.value, p_data: dt.value, p_observacao: ob.value, p_client_uuid: novoId() }); toast('Transferência registrada como pendente.', 'ok'); ob.value = ''; await carregar(); }
        catch (e) { toast(erroTexto(e), 'er'); } finally { b.disabled = false; }
      };
    }
    c.appendChild(form); c.appendChild(el('section', { class: 'card' }, [tabela]));
    async function carregar() {
      var t = await consulta(sb.from('transferencias').select('id,funcionario_id,origem_obra_id,destino_obra_id,data,situacao,observacao,motivo_cancelamento').order('data', { ascending: false }).limit(200));
      var tb = el('tbody');
      t.forEach(function (x) {
        var acoes = el('div', { class: 'acoes' });
        if (podeLancar && x.situacao === 'pendente') {
          acoes.appendChild(el('button', { type: 'button', class: 'btn min', text: 'Confirmar chegada', onclick: async function () { try { await rpc('confirmar_transferencia', { p_id: x.id }); toast('Transferência confirmada. Lotação atualizada.', 'ok'); carregar(); } catch (e) { toast(erroTexto(e), 'er'); } } }));
          acoes.appendChild(el('button', { type: 'button', class: 'btn perigo min', text: 'Cancelar', onclick: async function () { var m = prompt('Motivo do cancelamento:'); if (!m) return; try { await rpc('cancelar_transferencia', { p_id: x.id, p_motivo: m }); carregar(); } catch (e) { toast(erroTexto(e), 'er'); } } }));
        }
        tb.appendChild(el('tr', {}, [el('td', { text: dataBR(x.data) }), el('td', { text: (mapaF[x.funcionario_id] || {}).nome || '' }), el('td', { text: x.origem_obra_id ? nomeObra(mapaO[x.origem_obra_id]) : '—' }), el('td', { text: nomeObra(mapaO[x.destino_obra_id]) }),
          el('td', {}, [el('span', { class: 'selo ' + (x.situacao === 'confirmada' ? 'ok' : x.situacao === 'cancelada' ? 'ne' : 'av'), text: x.situacao })]), el('td', {}, [acoes])]));
      });
      limpar(tabela);
      if (!t.length) tabela.appendChild(el('p', { class: 'nota', text: 'Nenhuma transferência registrada.' }));
      else tabela.appendChild(el('table', {}, [el('thead', {}, [el('tr', {}, ['Data', 'Funcionário', 'Origem', 'Destino', 'Situação', ''].map(function (h) { return el('th', { text: h }); }))]), tb]));
    }
    S.recarregarTransf = function () { carregar().catch(function () { /* mantém */ }); };
    await carregar();
  }

  /* ================= PÁGINA: RELATÓRIOS ================= */
  // Excel/PDF gerados pelo exportador OFICIAL (modelo oficial da Masters, mesmo do sistema atual),
  // a partir dos dados do Supabase. Função de servidor "exportar" confere login e permissão.
  async function pgRelatorios(c) {
    var base = await carregarBase(), podeExportar = pode('relatorios.exportar');
    var hoje = hojeISO(), ini = hoje.slice(0, 8) + '01';
    var dIni = el('input', { type: 'date', value: ini, max: hoje }), dFim = el('input', { type: 'date', value: hoje, max: hoje });
    var obra = selecao([['', 'Todas as obras']].concat(base.obras.filter(function (o) { return o.situacao !== 'inativa'; }).map(function (o) { return [o.id, nomeObra(o)]; })), '');
    var msg = el('p', { class: 'msg', hidden: true });
    var bExcel = el('button', { type: 'button', class: 'btn', text: 'Exportar Excel' }), bPdf = el('button', { type: 'button', class: 'btn sec', text: 'Exportar PDF' });
    limpar(c);
    c.appendChild(el('h1', { class: 'tit', text: 'Relatórios e exportações' }));
    var card = el('section', { class: 'card', style: 'display:grid;gap:12px' }, [
      el('h2', { text: 'Controle de efetivo diário — modelo oficial' }),
      el('p', { class: 'nota', text: 'Mesmo arquivo do sistema atual (modelo oficial da Masters, com o TOTAL GERAL e os meses corrigidos). Somente funcionários ativos. Período de até 31 dias.' }),
      el('div', { class: 'form' }, [el('label', {}, ['Data inicial', dIni]), el('label', {}, ['Data final', dFim]), el('label', {}, ['Obra', obra])]),
      el('div', { class: 'acoes' }, [bExcel, bPdf]), msg
    ]);
    c.appendChild(card);
    if (!podeExportar) { bExcel.disabled = bPdf.disabled = true; mostrar('Seu perfil pode ver relatórios, mas não exportar. Peça a permissão "relatorios.exportar" ao administrador.', 'av'); }
    function mostrar(t, tipo) { msg.hidden = !t; msg.className = 'msg ' + (tipo || ''); msg.textContent = t || ''; }
    async function exportar(formato) {
      var a = dIni.value, b = dFim.value;
      if (!a || !b || a > b) return mostrar('Informe um período válido (a data inicial não pode ser depois da final).', 'er');
      if ((new Date(b) - new Date(a)) / 86400000 > 30) return mostrar('Selecione no máximo 31 dias.', 'er');
      if (!navigator.onLine) return mostrar('Sem internet: a exportação precisa de conexão.', 'er');
      bExcel.disabled = bPdf.disabled = true;
      mostrar('Gerando o arquivo no modelo oficial… pode levar até 1 minuto.', 'av');
      try {
        var r = await sb.functions.invoke('exportar', { body: { formato: formato, dataInicio: a, dataFim: b, obraId: obra.value } });
        var d = r.data;
        if (r.error) { try { d = await r.error.context.json(); } catch (x) { d = null; } }
        if (!d || !d.ok) throw new Error((d && d.mensagem) || 'Falha na exportação.');
        var bin = atob(d.base64), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: d.mime || 'application/octet-stream' }));
        var lk = el('a', { href: url, download: d.nome }); document.body.appendChild(lk); lk.click(); lk.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        mostrar('Pronto: ' + d.nome + ' (' + (d.resumo && d.resumo.obras) + ' obra(s), ' + (d.resumo && d.resumo.registros) + ' registro(s)). Se o download não abriu, toque de novo.', 'ok');
      } catch (e) { mostrar(erroTexto(e), 'er'); }
      finally { bExcel.disabled = bPdf.disabled = !podeExportar; }
    }
    bExcel.onclick = function () { exportar('EXCEL'); };
    bPdf.onclick = function () { exportar('PDF'); };
  }

  /* ================= PÁGINA: USUÁRIOS ================= */
  async function pgUsuarios(c) {
    var perfis = await consulta(sb.from('perfis').select('codigo,nome').order('nome'));
    var tabela = el('div', { class: 'tw' }), form = el('div', { class: 'card', hidden: true }), codigoBox = el('div');
    var novo = el('button', { type: 'button', class: 'btn', text: 'Novo usuário' });
    limpar(c);
    c.appendChild(el('div', { class: 'cab' }, [el('h1', { class: 'tit', text: 'Usuários e acessos' }), novo]));
    c.appendChild(el('p', { class: 'nota', text: 'O ADM não define a senha de ninguém. Conta nova fica Pendente e a própria pessoa cria a senha em "Primeiro acesso". Para recuperação, gere um código (válido por 72 h). Usuários não são apagados, só desativados; sempre resta ao menos um ADM ativo.' }));
    c.appendChild(form); c.appendChild(codigoBox); c.appendChild(el('section', { class: 'card' }, [tabela]));
    function abrirForm(u) {
      limpar(form); form.hidden = false;
      var nome = el('input', { value: u ? u.nome : '', maxlength: '80' }), login = el('input', { value: u ? u.usuario : '', maxlength: '30', autocapitalize: 'none' });
      if (u) login.disabled = true;
      var perfil = selecao(perfis.filter(function (p) { return p.codigo !== 'GESTOR' || (u && u.perfil === 'GESTOR'); }).map(function (p) { return [p.codigo, p.nome]; }), u ? u.perfil : 'USUARIO');
      var msg = el('p', { class: 'msg er', hidden: true }), salvar = el('button', { type: 'button', class: 'btn', text: 'Salvar' });
      form.appendChild(el('div', { class: 'form' }, [el('label', {}, ['Nome completo', nome]), el('label', {}, ['Nome de usuário', login]), el('label', {}, ['Perfil', perfil])]));
      form.appendChild(el('div', { class: 'acoes', style: 'margin-top:12px' }, [salvar, el('button', { type: 'button', class: 'btn sec', text: 'Cancelar', onclick: function () { form.hidden = true; } })])); form.appendChild(msg);
      salvar.onclick = async function () {
        salvar.disabled = true;
        try {
          if (u) await consulta(sb.from('usuarios').update({ nome: nome.value.trim(), perfil_codigo: perfil.value }).eq('id', u.id));
          else { await rpc('admin_criar_usuario', { p_nome: nome.value, p_login: login.value, p_perfil: perfil.value }); alert('Usuário cadastrado. Envie o link do aplicativo e o nome de usuário ao colega: ele deve tocar em "Primeiro acesso / criar minha senha".'); }
          form.hidden = true; carregar();
        } catch (e) { msg.hidden = false; msg.textContent = erroTexto(e); } finally { salvar.disabled = false; }
      };
    }
    async function carregar() {
      var l = await rpc('admin_listar_usuarios'), tb = el('tbody');
      l.forEach(function (u) {
        var acoes = el('div', { class: 'acoes' });
        acoes.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Editar', onclick: function () { abrirForm(u); } }));
        if (u.situacao !== 'Inativo') acoes.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Gerar código de recuperação', onclick: async function () {
          if (!confirm('Gerar um código de recuperação para ' + u.nome + '? A senha atual continua valendo até a pessoa criar outra.')) return;
          try {
            var r = await rpc('admin_gerar_codigo', { p_usuario_id: u.id });
            limpar(codigoBox).appendChild(el('section', { class: 'card', style: 'display:grid;gap:8px;border:2px solid #394086' }, [
              el('h2', { text: 'Código para ' + r.nome }), el('p', { class: 'nota', text: 'Envie ao usuário. Ele abre "Esqueci minha senha", informa o usuário e o código e cria a nova senha. Validade: 72 horas. Este código não será mostrado de novo.' }),
              el('p', { style: 'font-family:monospace;font-size:16px;word-break:break-all;background:#f3f4f8;padding:10px;border-radius:8px', text: 'Usuário: ' + r.usuario + '\nCódigo: ' + r.codigo }),
              el('button', { type: 'button', class: 'btn sec min', text: 'Copiar', onclick: function () { try { navigator.clipboard.writeText('Usuário: ' + r.usuario + '\nCódigo: ' + r.codigo); toast('Copiado.', 'ok'); } catch (e) { toast('Copie manualmente.', 'av'); } } }),
              el('button', { type: 'button', class: 'btn sec min', text: 'Fechar', onclick: function () { limpar(codigoBox); } })]));
            carregar();
          } catch (e) { toast(erroTexto(e), 'er'); }
        } }));
        var ativo = u.situacao !== 'Inativo';
        acoes.appendChild(el('button', { type: 'button', class: 'btn min ' + (ativo ? 'perigo' : 'sec'), text: ativo ? 'Desativar' : 'Ativar', onclick: async function () {
          if (!confirm((ativo ? 'Desativar' : 'Ativar') + ' o acesso de ' + u.nome + '?')) return;
          try { await consulta(sb.from('usuarios').update({ ativo: !ativo }).eq('id', u.id)); carregar(); } catch (e) { toast(erroTexto(e), 'er'); }
        } }));
        var cls = { 'Ativo': 'ok', 'Inativo': 'ne', 'Pendente': 'av', 'Aguardando migração': 'av', 'Recuperação pendente': 'av' }[u.situacao] || 'ne';
        tb.appendChild(el('tr', {}, [el('td', { text: u.nome }), el('td', { text: u.usuario }), el('td', { text: u.perfil_nome }), el('td', {}, [el('span', { class: 'selo ' + cls, text: u.situacao })]), el('td', { text: dataHoraBR(u.ultimo_acesso) }), el('td', {}, [acoes])]));
      });
      limpar(tabela).appendChild(el('table', {}, [el('thead', {}, [el('tr', {}, ['Nome', 'Usuário', 'Perfil', 'Situação', 'Último acesso', ''].map(function (h) { return el('th', { text: h }); }))]), tb]));
    }
    novo.onclick = function () { abrirForm(null); };
    await carregar();
  }

  /* ================= PÁGINA: CONFIGURAÇÕES ================= */
  async function pgConfig(c) {
    limpar(c);
    c.appendChild(el('h1', { class: 'tit', text: 'Configurações' }));
    var filaBox = el('div', { style: 'display:grid;gap:8px' });
    c.appendChild(el('section', { class: 'card', style: 'display:grid;gap:10px' }, [el('h2', { text: 'Apontamentos feitos sem internet neste aparelho' }), filaBox]));
    c.appendChild(el('section', { class: 'card', style: 'display:grid;gap:6px' }, [el('h2', { text: 'Sobre' }),
      el('p', { class: 'nota', text: 'Efetivo Diário — Masters · versão ' + CFG.versao + ' · usuário ' + S.usuario.usuario + ' (' + S.usuario.perfilNome + ')' }),
      el('p', { class: 'nota', text: 'Backup automático e exportações: em implantação (etapa 7). O sistema atual segue oficial durante o período em paralelo.' })]));
    async function pintarFila() {
      var l = await atualizarSeloFila(); limpar(filaBox);
      if (!l.length) { filaBox.appendChild(el('p', { class: 'msg ok', text: 'Tudo sincronizado.' })); return; }
      l.forEach(function (it) {
        filaBox.appendChild(el('div', { class: 'card', style: 'display:grid;gap:6px' }, [
          el('b', { text: (it.obra_nome || '') + ' — ' + dataBR(it.data) + ' · ' + it.itens.length + ' funcionário(s)' }),
          el('span', { class: 'nota', text: 'Feito em ' + dataHoraBR(it.criado_em) + (it.erro ? '' : ' · aguardando envio') }),
          it.erro ? el('p', { class: 'msg er', text: 'Não foi aceito pelo servidor: ' + it.erro }) : null,
          it.erro ? el('button', { type: 'button', class: 'btn perigo min', text: 'Descartar este apontamento', onclick: async function () { if (confirm('Descartar? Ele não será enviado.')) { await filaRemover(it.id); pintarFila(); } } }) : null
        ]));
      });
      filaBox.appendChild(el('button', { type: 'button', class: 'btn sec min', text: 'Enviar agora', onclick: async function () { await sincronizarFila(); pintarFila(); } }));
    }
    await pintarFila();
  }

  /* ================= SESMT (etapa 5) ================= */
  function pgSESMT() {
    var c = limpar($('conteudo'));
    c.appendChild(el('h1', { class: 'tit', text: 'SESMT' }));
    c.appendChild(el('p', { class: 'msg av', text: 'O ambiente SESMT (EPIs, fardamentos, entregas, solicitações e alertas) será implantado na etapa 5, usando os mesmos funcionários e obras do RH.' }));
  }

  /* ---------------- início ---------------- */
  if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* sem PWA */ }); }); }
  sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && S.usuario) { S.usuario = null; telaAcesso('login', 'Sessão encerrada. Entre novamente.'); } });
  (async function iniciar() {
    try {
      var sess = (await sb.auth.getSession()).data.session;
      if (!sess) { telaAcesso('login'); return; }
      await aposLogin(false);
    } catch (e) { telaAcesso('login', erroTexto(e)); }
  })();
})();
