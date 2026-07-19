import {
  exigirAplicativoAtero
} from "./access-guard.js?v=1";


async function iniciar() {
  const acesso =
    await exigirAplicativoAtero({
      appId: "ID_APP",
      nomeFallback:
        "Atero APP_NAME"
    });

  if (!acesso) {
    return;
  }

  const modulo =
    await import(
      "./app.js?v=1"
    );

  await modulo.iniciarAplicativo({
    usuario:
      acesso.user,

    aplicativo:
      acesso.app
  });
}


iniciar();
