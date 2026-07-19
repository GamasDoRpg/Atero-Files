import {
  exigirAplicativoAtero
} from "./access-guard.js?v=1";


async function iniciar() {
  const acesso =
    await exigirAplicativoAtero({
      appId: "files",
      nomeFallback:
        "Atero Files"
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
