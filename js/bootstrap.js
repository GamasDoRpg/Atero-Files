import {
  exigirAplicativoAtero
} from "./access-guard.js?v=1";

async function iniciar() {
  const acesso = await exigirAplicativoAtero({
    appId: "files",
    nomeFallback: "Atero Files"
  });

  if (!acesso) {
    return;
  }

  try {
    const modulo = await import("./app.js?v=1");

    await modulo.iniciarAplicativo({
      usuario: acesso.user,
      aplicativo: acesso.app
    });
  } catch (error) {
    console.error("Não foi possível iniciar o Atero Files:", error);

    const tela = document.querySelector("#atero-access-screen");
    if (tela) {
      tela.hidden = false;
      tela.innerHTML = `
        <div class="atero-access-card">
          <div class="atero-access-error-icon" aria-hidden="true">!</div>
          <h1>Não foi possível abrir o Files</h1>
          <p>Atualize a página. Se o problema continuar, a aplicação pode estar temporariamente indisponível.</p>
          <div class="atero-access-actions">
            <button class="atero-access-button" type="button" id="atero-files-reload">Atualizar página</button>
            <a class="atero-access-link" href="https://atero.space">Voltar ao Atero</a>
          </div>
        </div>
      `;

      document.documentElement.dataset.accessState = "denied";
      document.querySelector("#atero-files-reload")?.addEventListener("click", () => window.location.reload());
    }
  }
}

iniciar();
