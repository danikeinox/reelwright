<div align="center">

<img src="docs/assets/banner.png" alt="Reelwright: tu web, convertida en Reel de Instagram" width="100%">

# Reelwright

**Convierte tu web en Reels de Instagram desde Claude.**<br>
Se renderizan en tu propio ordenador. Solo se publican si tú los apruebas.

[English](README.md) · [Documentación](docs) · [Modelo de amenazas](docs/THREAT-MODEL.md) · [Web](https://danikeinox.github.io/reelwright/es/)

<img src="docs/assets/demo.gif" alt="Un reel renderizado por Reelwright" width="240">

<sub>Un reel real de 1080×1920 renderizado con <code>reelwright demo</code> (12 s).</sub>

</div>

---

Reelwright es un servidor [MCP](https://modelcontextprotocol.io) open source y local. Hablas con Claude (o cualquier cliente MCP), Claude escribe el guion y Reelwright renderiza un reel vertical en **tu máquina**, espera **tu** aprobación y lo publica en **tu** Instagram. Sin nube de Reelwright, sin suscripción, sin cuenta con nadie.

> **Estado: v0.2, temprano.** El motor de render, el flujo de aprobación, el panel y los controles de seguridad tienen 164 tests automáticos, incluido uno de extremo a extremo con un cliente MCP real y el renderizador real. **No** se ha probado aún con una cuenta real de Instagram, un túnel de Cloudflare real, R2, Windows ni macOS: haz tu primera publicación con una cuenta de prueba.

## Por qué

- **Render local** con Remotion y Chrome headless: no pagas nada por vídeo.
- **Tu IA**: la del cliente MCP que conectes. Reelwright nunca llama a un LLM.
- **Tu almacenamiento**: Instagram necesita un enlace público al vídeo unos segundos. Usa un túnel temporal gratuito de Cloudflare (no se guarda nada) o tu propio bucket S3 / Cloudflare R2 (el archivo se borra al publicar).
- **Voz opcional**: cualquier TTS local compatible con OpenAI, p. ej. [VoiceStudio](https://github.com/debpalash/VoiceStudio).
- **Decide una persona**: ninguna herramienta permite que la IA apruebe. La aprobación va ligada al vídeo y al texto exactos que revisaste.

## Inicio rápido

Necesitas Node.js 22.12 o superior (recomendado 24 LTS).

```bash
git clone https://github.com/danikeinox/reelwright && cd reelwright
npm ci && npm run build && npm link     # el paquete npm llegará con la primera release

reelwright setup     # asistente: navegador, almacenamiento, Instagram, voz y Claude
reelwright demo      # renderiza el reel de arriba
```

`reelwright setup` termina añadiendo Reelwright a Claude Desktop (reinícialo después). Para Claude Code usa el comando que muestra `reelwright install-claude --print`.

Luego, en Claude:

> Aprende mi marca desde https://ejemplo.com y hazme un reel sobre el menú de otoño.

Claude usa `brand_init` y `render_reel`; tú revisas el vídeo, lo apruebas y Claude llama a `publish_reel`. ¿Algo no funciona? `reelwright doctor` revisa todo e indica el arreglo exacto.

## El panel de gestión

`reelwright ui`, o pídele a Claude *"abre el dashboard"*. Aquí está todo lo que necesita tus propias manos: conectar Instagram, almacenamiento y voz, leer tu marca y revisar reels. Solo existe mientras Reelwright corre en tu ordenador; no hay nada que alojar.

<table>
<tr>
<td width="50%"><img src="docs/assets/panel-review.png" alt="Revisión de un reel"><br><sub><b>Revisión.</b> Ves el vídeo, lees el texto completo y apruebas exactamente eso.</sub></td>
<td width="50%"><img src="docs/assets/panel-connections.png" alt="Conexiones"><br><sub><b>Conexiones.</b> Instagram, almacenamiento y voz. Los secretos se guardan pero nunca se muestran.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/panel-overview.png" alt="Estado"><br><sub><b>Estado.</b> Las mismas comprobaciones que <code>reelwright doctor</code>.</sub></td>
<td><img src="docs/assets/panel-brand.png" alt="Marca"><br><sub><b>Marca.</b> Nombre, colores y fuentes leídos de tu web.</sub></td>
</tr>
</table>

### Opcional: panel remoto en tu propia cuenta de Cloudflare

Si quieres mirar desde el móvil, puedes desplegar un pequeño Worker en **tu** cuenta de Cloudflare ([guía](worker/README.md), unos 10 minutos, plan gratuito). Si no lo haces, nada cambia.

<img src="docs/assets/remote-dashboard.png" alt="Panel remoto en el móvil" width="300" align="right">

Muestra el estado, permite editar un texto, rechazar un reel y cambiar colores. **No puede aprobar ni publicar** y **nunca recibe un token**. Aunque alguien tomara el Worker, lo peor que podría hacer es rechazar un reel o cambiar un texto (lo que anula su aprobación y te obliga a aprobar de nuevo en tu ordenador).

<br clear="right">

## Qué puede hacer Claude (herramientas MCP)

| Herramienta | Qué hace |
| --- | --- |
| `doctor` | Comprueba render, navegador, almacenamiento, Instagram y voz |
| `brand_init` / `brand_get` | Lee tu web pública (nombre, colores, fuentes) |
| `render_reel` | Renderiza un reel en local y lo deja pendiente de aprobación |
| `list_media` | Nombres de las capturas que añadiste (para escenas de móvil) y si hay logo y música |
| `list_reels` / `get_reel` | Progreso y estado |
| `publish_reel` | Publica un reel **que tú aprobaste** |
| `get_comments` / `reply_comment` | Lee comentarios; responde solo tras tu confirmación |
| `open_dashboard` | Abre el panel local (su enlace privado nunca se muestra a la IA) |

A propósito **no existe** ninguna herramienta que apruebe un reel.

### Reels completos: escenas, capturas, logo y música

Además del reel de texto, `render_reel` puede montar un reel por **escenas**: un titular grande animado, un móvil con una de tus capturas, una tarjeta animada (p. ej. *Agotado → Disponible → Pedido*), una lista, un precio y un cierre con tu logo, con música de fondo. Tú añades los archivos una vez y Claude solo los elige por nombre:

```
reelwright logo ./logo-blanco.png
reelwright media add ./capturas/carrito.png --name carrito
reelwright music ./mi-pista.wav        # solo música con derechos de uso
```

## Seguridad

La aprobación queda ligada al hash del vídeo y del texto que viste; la IA no puede aprobar por MCP; lo que viene de webs y comentarios se trata como dato no fiable; la lectura de webs bloquea redes privadas (SSRF); el panel local solo escucha en loopback con token, CSP estricta y comprobación de `Host`/`Origin`; los secretos se guardan con permisos `0600` y no se devuelven nunca. Detalle completo en el [modelo de amenazas](docs/THREAT-MODEL.md) y en [SECURITY.md](SECURITY.md).

## Licencias

MIT. Remotion es gratis para particulares y equipos de hasta 3 personas; las empresas mayores necesitan [licencia de Remotion](https://www.remotion.dev/license). VoiceStudio (AGPL) es opcional y se usa por HTTP. Proyecto independiente, no afiliado a Meta, Instagram, Cloudflare ni Anthropic. Más detalle en el [README en inglés](README.md#licences-and-third-parties).

## Desarrollo

```bash
git clone https://github.com/danikeinox/reelwright && cd reelwright
npm ci && npm test
```

PRs bienvenidos: [CONTRIBUTING.md](CONTRIBUTING.md).
