const API_BASE_URL =
  "https://api.atero.space";

const ATERO_HUB_URL =
  "https://atero.space";

const AUTH_BRIDGE_URL =
  "https://atero.space/auth-bridge.html";

const LOGIN_URL =
  "https://atero.space/login.html";

const SELECIONAR_APPS_URL =
  "https://atero.space/selecionar-apps.html";

const TEMPO_LIMITE_REQUISICAO =
  15000;


/*
  Lê uma resposta JSON sem quebrar caso
  o servidor retorne texto ou corpo vazio.
*/
async function lerResposta(resposta) {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}


/*
  Obtém ou cria a tela que mostra
  o estado da autenticação.
*/
function obterTelaAcesso() {
  let tela =
    document.querySelector(
      "#atero-access-screen"
    );

  if (tela) {
    return tela;
  }

  tela =
    document.createElement("section");

  tela.id =
    "atero-access-screen";

  tela.className =
    "atero-access-screen";

  tela.setAttribute(
    "role",
    "status"
  );

  tela.setAttribute(
    "aria-live",
    "polite"
  );

  document.body.prepend(tela);

  return tela;
}


/*
  Mostra uma mensagem durante a
  verificação de acesso.
*/
function mostrarCarregamento(
  nomeAplicativo
) {
  const tela =
    obterTelaAcesso();

  tela.innerHTML = `
    <div class="atero-access-card">
      <div
        class="atero-access-spinner"
        aria-hidden="true"
      ></div>

      <h1>Verificando acesso</h1>

      <p>
        Preparando o ${nomeAplicativo}.
      </p>
    </div>
  `;

  tela.hidden = false;

  document.documentElement.dataset
    .accessState = "checking";
}


/*
  Mostra uma tela de erro com ações.
*/
function mostrarErro({
  titulo,
  mensagem,
  acaoPrincipal = null,
  textoAcaoPrincipal = null,
  permitirTentarNovamente = true
}) {
  const tela =
    obterTelaAcesso();

  const botaoPrincipal =
    acaoPrincipal &&
    textoAcaoPrincipal
      ? `
          <a
            class="atero-access-button"
            href="${acaoPrincipal}"
          >
            ${textoAcaoPrincipal}
          </a>
        `
      : "";

  const botaoTentarNovamente =
    permitirTentarNovamente
      ? `
          <button
            class="
              atero-access-button
              atero-access-button-secondary
            "
            id="atero-access-retry"
            type="button"
          >
            Tentar novamente
          </button>
        `
      : "";

  tela.innerHTML = `
    <div class="atero-access-card">
      <div
        class="atero-access-error-icon"
        aria-hidden="true"
      >
        !
      </div>

      <h1>${titulo}</h1>

      <p>${mensagem}</p>

      <div class="atero-access-actions">
        ${botaoPrincipal}
        ${botaoTentarNovamente}

        <a
          class="atero-access-link"
          href="${ATERO_HUB_URL}"
        >
          Voltar ao Atero
        </a>
      </div>
    </div>
  `;

  tela.hidden = false;

  document.documentElement.dataset
    .accessState = "denied";
}


/*
  Libera visualmente o aplicativo.
*/
function liberarAplicativo() {
  const tela =
    document.querySelector(
      "#atero-access-screen"
    );

  if (tela) {
    tela.hidden = true;
  }

  document.documentElement.dataset
    .accessState = "authorized";
}


/*
  Redireciona para a ponte de autenticação.

  A ponte usa a sessão persistida no
  atero.space, sincroniza o access token
  com a API e devolve o usuário ao app.
*/
function redirecionarParaPonte(
  appId
) {
  const chaveTentativa =
    `atero-auth-bridge-${appId}`;

  const ultimaTentativa =
    Number(
      sessionStorage.getItem(
        chaveTentativa
      ) || 0
    );

  const agora =
    Date.now();

  /*
    Evita um loop infinito caso a ponte
    não consiga criar a sessão da API.
  */
  if (
    ultimaTentativa &&
    agora - ultimaTentativa < 15000
  ) {
    mostrarErro({
      titulo:
        "Não foi possível preparar sua sessão",

      mensagem:
        "A sessão da sua Conta Atero foi reconhecida, " +
        "mas a API não conseguiu concluir a autenticação.",

      acaoPrincipal:
        `${LOGIN_URL}?return_to=${encodeURIComponent(
          window.location.href
        )}`,

      textoAcaoPrincipal:
        "Entrar novamente"
    });

    return;
  }

  sessionStorage.setItem(
    chaveTentativa,
    String(agora)
  );

  const url =
    new URL(
      AUTH_BRIDGE_URL
    );

  url.searchParams.set(
    "return_to",
    window.location.href
  );

  window.location.replace(
    url.href
  );
}


/*
  Verifica se o ID recebido é válido.
*/
function validarAppId(appId) {
  return /^[a-z0-9_-]+$/.test(
    appId
  );
}


/*
  Verifica se o usuário pode usar
  determinado aplicativo.
*/
export async function exigirAplicativoAtero({
  appId,
  nomeFallback =
    "aplicativo Atero"
}) {
  const id =
    String(appId || "")
      .trim()
      .toLowerCase();

  if (!validarAppId(id)) {
    mostrarErro({
      titulo:
        "Aplicativo inválido",

      mensagem:
        "O identificador deste aplicativo " +
        "não foi configurado corretamente.",

      permitirTentarNovamente:
        false
    });

    return null;
  }

  mostrarCarregamento(
    nomeFallback
  );

  const controlador =
    new AbortController();

  const timeoutId =
    window.setTimeout(
      () => {
        controlador.abort();
      },
      TEMPO_LIMITE_REQUISICAO
    );

  try {
    const resposta =
      await fetch(
        `${API_BASE_URL}/access/${encodeURIComponent(id)}`,
        {
          method: "GET",

          credentials:
            "include",

          cache:
            "no-store",

          headers: {
            Accept:
              "application/json"
          },

          signal:
            controlador.signal
        }
      );

    const dados =
      await lerResposta(
        resposta
      );


    /*
      Usuário sem cookie válido na API.
    */
    if (resposta.status === 401) {
      redirecionarParaPonte(id);

      return null;
    }


    /*
      Usuário autenticado, mas o app
      não está selecionado.
    */
    if (resposta.status === 403) {
      mostrarErro({
        titulo:
          "Aplicativo não selecionado",

        mensagem:
          `O ${nomeFallback} não está incluído ` +
          "nos aplicativos ativos da sua conta.",

        acaoPrincipal:
          SELECIONAR_APPS_URL,

        textoAcaoPrincipal:
          "Gerenciar aplicativos"
      });

      return null;
    }


    /*
      Aplicativo inexistente ou desativado.
    */
    if (resposta.status === 404) {
      mostrarErro({
        titulo:
          "Aplicativo indisponível",

        mensagem:
          `O ${nomeFallback} ainda não está disponível ` +
          "ou foi temporariamente desativado.",

        permitirTentarNovamente:
          false
      });

      return null;
    }


    if (!resposta.ok) {
      throw new Error(
        dados?.detail ||
        dados?.message ||
        `A API retornou o erro HTTP ${resposta.status}.`
      );
    }


    sessionStorage.removeItem(
      `atero-auth-bridge-${id}`
    );

    liberarAplicativo();

    return dados;
  } catch (erro) {
    console.error(
      `Erro ao verificar acesso ao app ${id}:`,
      erro
    );

    const foiTimeout =
      erro?.name ===
      "AbortError";

    mostrarErro({
      titulo:
        foiTimeout
          ? "A API demorou para responder"
          : "Não foi possível verificar seu acesso",

      mensagem:
        foiTimeout
          ? (
              "A conexão com a Atero API excedeu " +
              "o tempo limite."
            )
          : (
              "Verifique sua conexão e tente novamente. " +
              "Se o problema continuar, a API pode estar indisponível."
            )
    });

    return null;
  } finally {
    window.clearTimeout(
      timeoutId
    );
  }
}
