'use strict';

const path = require('node:path');

const REFRESH = 'rocketbrain.javafx.refreshPreview';
const EDIT = 'rocketbrain.javafx.editPreviewProperty';
const APPLY = 'rocketbrain.javafx.applyPreviewProperty';
const DISCARD = 'rocketbrain.javafx.discardPreviewProperty';
const commandUris = [REFRESH, EDIT, APPLY, DISCARD];

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const href = (command, ...args) => 'command:' + command +
  (args.length ? '?' + escape(encodeURIComponent(JSON.stringify(args))) : '');
const label = target => escape(target.type + ' · ' + target.id);

function image(frame, alt) {
  return '<img alt="' + alt + '" width="' + frame.width + '" height="' + frame.height +
    '" src="data:image/png;base64,' + frame.png.toString('base64') + '">';
}

function surface(frame) {
  const editable = frame.changed ? [] : frame.design.targets;
  const hotspots = editable.filter(target => target.bounds).map(target => {
    const { x, y, width, height } = target.bounds;
    const positions = { left: x / frame.width, top: y / frame.height,
      width: width / frame.width, height: height / frame.height };
    const style = Object.entries(positions).map(([key, fraction]) => key + ':' + 100 * fraction + '%').join(';');
    return '<a class="hotspot" href="' + href(EDIT, frame.ticket, target.id) + '" style="' + style +
      '" title="' + label(target) + '" aria-label="Edit ' + label(target) + '"></a>';
  }).join('');
  const items = editable.map(target => '<li><a href="' + href(EDIT, frame.ticket, target.id) + '">' +
    label(target) + '</a></li>').join('');
  return '<div class="surface" style="width:min(100%,' + frame.width + 'px)">' +
    image(frame, 'Rendered JavaFX layout') + hotspots + '</div>' +
    (items ? '<h2>Editable elements</h2><ul class="elements">' + items + '</ul>' : '');
}

function proposal(frame, review) {
  const { edit } = review.frame.design;
  return '<h2>Review property change</h2><p>' + label(edit) + ' · <code>' + escape(edit.property) +
    '</code></p><dl><dt>Original value</dt><dd><code>' + escape(edit.before) +
    '</code></dd><dt>Proposed value</dt><dd><code>' + escape(edit.after) + '</code></dd></dl>' +
    '<div class="comparison"><figure><figcaption>Original</figcaption>' +
    image(frame, 'Original JavaFX render') + '</figure><figure><figcaption>Proposed</figcaption>' +
    image(review.frame, 'Proposed JavaFX render') + '</figure></div>' +
    '<p class="actions"><a href="' + href(APPLY, review.ticket) + '">Apply to FXML Editor</a>' +
    '<a href="' + href(DISCARD, review.ticket) + '">Discard</a></p>';
}

function previewHtml(frame, review) {
  const omission = frame.receipt.controllersOmitted || frame.receipt.handlersOmitted
    ? '<p>Static view · controller and event hookups omitted</p>' : '';
  const action = frame.changed ? '<p role="status">Save the FXML editor, then refresh the preview.</p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
    <title>JavaFX FXML Preview</title><style>
    body{padding:18px}h1{font-size:1.2rem}h2{font-size:1.05rem}
    img{display:block;max-width:100%;height:auto}a{color:var(--vscode-textLink-foreground)}
    .surface{position:relative}.surface img{width:100%}.hotspot{position:absolute;box-sizing:border-box}
    .hotspot:hover,.hotspot:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:-2px}
    .elements{padding-inline-start:1.5em}.comparison{display:flex;gap:20px;flex-wrap:wrap}
    figure{min-width:0;margin:0}figcaption{margin-bottom:6px}dd{overflow-wrap:anywhere}
    .actions{display:flex;flex-wrap:wrap;gap:18px}
    </style></head><body><h1>` + escape(path.basename(frame.uri.fsPath)) + '</h1>' + omission +
    '<p><a href="' + href(REFRESH) + '">Refresh Preview</a></p>' + action +
    (review ? proposal(frame, review) : surface(frame)) + '</body></html>';
}

module.exports = { REFRESH, EDIT, APPLY, DISCARD, commandUris, previewHtml };
