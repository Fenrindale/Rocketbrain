'use strict';

const { identifier } = require('./schema-rename');
const { qualifiedSqlName } = require('./object-reference');

const prefix = 'rocketbrain.schemaCatalog.';
const maxSchemas = 16;
const maxExcluded = 500;
const maxVisiblePages = 5;
const identityOf = object => JSON.stringify([object.schema, object.kind, object.name]);

function registerSchemaCatalog(context, vscode, { database, objectSources }) {
  const events = new vscode.EventEmitter();
  const cursors = new Map();
  let generation = 0;
  let disposed = false;
  let pending = Promise.resolve();

  function frame() {
    const live = database.liveCatalogIdentity();
    return vscode.workspace.isTrusted && !disposed && live && { ...live, generation };
  }

  function guard(offer) {
    const live = frame();
    if (!live || !offer || offer.generation !== live.generation || offer.epoch !== live.epoch ||
        offer.connection !== live.connection) throw Error('The schema catalog changed. Choose an object from the current connection.');
  }

  function queued(offer, action) {
    const result = pending.then(async () => {
      guard(offer);
      const value = await action();
      guard(offer);
      return value;
    });
    pending = result.catch(() => {});
    return result;
  }

  function settings(offer) {
    return context.workspaceState.get(prefix + offer.connection) || { schemas: [offer.database], excluded: [] };
  }

  function invalidate() {
    generation++;
    cursors.clear();
    events.fire();
  }

  async function availableSchemas(offer) {
    const names = [];
    let after = '';
    let kinds = [];
    for (let page = 0; page < maxVisiblePages; page++) {
      const observed = await objectSources.listSchemas({ after });
      guard(offer);
      names.push(...observed.items.map(item => item.name));
      kinds = observed.kinds.filter(item => item.kind !== 'schema');
      after = observed.next;
      if (!after) break;
    }
    return { names, kinds, truncated: Boolean(after) };
  }

  async function select(schemas, offer = frame()) {
    if (!Array.isArray(schemas) || schemas.length > maxSchemas) throw Error('Choose up to 16 visible schemas.');
    const ordered = [...new Set(schemas.map(schema => identifier(schema, { table: true })))];
    await queued(offer, async () => {
      const visible = new Set((await availableSchemas(offer)).names);
      if (!ordered.every(schema => visible.has(schema))) throw Error('Choose schemas visible to the current account.');
      const { excluded } = settings(offer);
      await context.workspaceState.update(prefix + offer.connection, { schemas: ordered, excluded });
    });
    invalidate();
    return ordered;
  }

  async function list(schema, kind, after = '', offer = frame()) {
    return queued(offer, async () => {
      const { schemas, excluded } = settings(offer);
      if (!schemas.includes(schema)) throw Error('Choose a schema included in the current catalog.');
      if (typeof kind !== 'string' || kind === 'schema') throw Error('Choose a database object kind.');
      const { items, next } = await objectSources.listObjects({ schema, kind, after });
      const hidden = new Set(excluded.map(identityOf));
      return { items: items.filter(item => !hidden.has(identityOf(item))), next };
    });
  }

  async function setExcluded(object, exclude, offer = frame()) {
    if (typeof exclude !== 'boolean') throw Error('Choose whether to hide or show the object.');
    const value = {
      schema: identifier(object?.schema, { table: true }),
      kind: object?.kind,
      name: identifier(object?.name)
    };
    await queued(offer, async () => {
      const { schemas, excluded } = settings(offer);
      if (exclude) {
        if (!schemas.includes(value.schema) || typeof value.kind !== 'string' || value.kind === 'schema') {
          throw Error('Choose an object in a selected catalog schema.');
        }
        // Verify the kind against this database, without changing the selected schema.
        const { kinds } = await objectSources.listSchemas();
        guard(offer);
        if (!kinds.some(kind => kind.kind === value.kind)) throw Error('Choose a supported database object kind.');
      }
      const updated = excluded.filter(item => identityOf(item) !== identityOf(value));
      if (exclude) updated.push(value);
      if (updated.length > maxExcluded) throw Error('Restore another hidden object before hiding more than 500 objects.');
      await context.workspaceState.update(prefix + offer.connection, { schemas, excluded: updated });
    });
    invalidate();
    return { ...value, excluded: exclude };
  }

  async function open(object, offer = frame()) {
    return queued(offer, () => {
      const { schemas, excluded } = settings(offer);
      if (!schemas.includes(object?.schema) || excluded.some(item => identityOf(item) === identityOf(object))) {
        throw Error('Open an included database object from the current catalog.');
      }
      return objectSources.open(object);
    });
  }

  function newItem(label, collapsible, values = {}) {
    return Object.assign(new vscode.TreeItem(label, collapsible), values);
  }

  const { None, Collapsed } = vscode.TreeItemCollapsibleState;
  const provider = {
    onDidChangeTreeData: events.event,
    getTreeItem: item => item,
    async getChildren(parent) {
      const offer = parent?.offer ?? frame();
      if (!offer) return [];
      try {
        guard(offer);
        const state = settings(offer);
        if (!parent) {
          const visible = await queued(offer, () => availableSchemas(offer));
          return state.schemas.map(schema => {
            const active = visible.names.includes(schema);
            return newItem(schema, active ? Collapsed : None, { id: JSON.stringify([offer.connection, schema]), schema, offer,
              kinds: visible.kinds, description: active ? (schema === offer.database ? 'SQL default' : undefined) : 'Unavailable',
              contextValue: active ? 'rocketbrain.schemaCatalogSchema' : undefined,
              iconPath: new vscode.ThemeIcon('database') });
          });
        }
        if (parent.kinds) {
          return parent.kinds.map(({ label, kind }) => newItem(label, Collapsed,
            { id: JSON.stringify([offer.connection, parent.schema, kind]), offer, schema: parent.schema, objectKind: kind }));
        }
        if (!parent.objectKind) return [];
        const key = parent.id;
        const trail = cursors.get(key) || [''];
        const after = trail.at(-1);
        const page = await list(parent.schema, parent.objectKind, after, offer);
        const items = page.items.map(object => {
          const item = newItem(object.name, None, { id: JSON.stringify([offer.connection, identityOf(object)]), object, offer,
            contextValue: 'rocketbrain.schemaCatalogObject' });
          item.command = { command: prefix + 'open', title: 'Open Object Source', arguments: [{ object, offer }] };
          return item;
        });
        const move = (label, cursor) => newItem(label, None, { command: {
          command: prefix + 'page', title: label, arguments: [{ key, trail, cursor, offer }]
        } });
        if (trail.length > 1) items.unshift(move('Previous page', null));
        if (page.next) items.push(move('Next page', page.next));
        return items;
      } catch {
        return frame()?.generation === offer.generation
          ? [newItem('Catalog unavailable · refresh to retry', None)] : [];
      }
    }
  };

  function command(name, action) {
    return vscode.commands.registerCommand(prefix + name, async argument => {
      try { return await action(argument); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain schema catalog: ' + error.message); }
    });
  }

  const subscriptions = [events, database.onDidChangeDatabase(invalidate),
    vscode.window.registerTreeDataProvider('rocketbrain.schemaCatalog', provider),
    command('select', async () => {
      const offer = frame();
      const visible = await queued(offer, () => availableSchemas(offer));
      const selected = new Set(settings(offer).schemas);
      const choices = visible.names.map(label => ({ label, picked: selected.has(label) }));
      const desired = await vscode.window.showQuickPick(choices, { canPickMany: true,
        title: 'Choose Up To 16 Catalog Schemas',
        placeHolder: visible.truncated ? 'Showing the first 500 visible schemas' : 'Select schemas to explore together' });
      if (desired) return select(desired.map(item => item.label), offer);
    }),
    command('open', item => open(item?.object, item?.offer)),
    command('copyReference', item => {
      guard(item?.offer);
      const { schemas, excluded } = settings(item.offer);
      const schema = item.object?.schema ?? item.schema;
      if (!schemas.includes(schema) || (item.object && excluded.some(object => identityOf(object) === identityOf(item.object)))) {
        throw Error('Choose an included database object from the current catalog.');
      }
      return vscode.env.clipboard.writeText(qualifiedSqlName('mysql', schema, ...(item.object ? [item.object.name] : [])));
    }),
    command('hide', item => setExcluded(item?.object, true, item?.offer)),
    command('restore', async () => {
      const offer = frame();
      guard(offer);
      const choices = settings(offer).excluded.map(object => ({ label: object.name,
        description: object.schema + ' · ' + object.kind, object }));
      const chosen = await vscode.window.showQuickPick(choices, { title: 'Restore Hidden Database Object' });
      if (chosen) return setExcluded(chosen.object, false, offer);
    }),
    command('refresh', invalidate),
    command('page', ({ key, trail, cursor, offer } = {}) => {
      guard(offer);
      if ((cursors.get(key) || ['']).at(-1) !== trail?.at(-1)) return;
      cursors.set(key, cursor === null ? trail.slice(0, -1) : [...trail, cursor]);
      events.fire();
    })
  ];

  return { select, list, open, setExcluded,
    visibleSchemas() { const offer = frame(); return queued(offer, () => availableSchemas(offer)); },
    selection() { const offer = frame(); return offer ? structuredClone(settings(offer)) : null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      cursors.clear();
      for (const subscription of subscriptions) subscription.dispose();
    } };
}

module.exports = { registerSchemaCatalog };
