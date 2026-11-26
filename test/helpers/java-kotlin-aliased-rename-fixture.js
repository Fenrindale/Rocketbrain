'use strict';

const base = require('./java-kotlin-rename-fixture');

const factory = 'src/main/kotlin/mixed/reverse/app/ShippingFactory.kt';
const files = new Map(base.files);
files.set(base.kotlin, base.files.get(base.kotlin)
  .replace('import mixed.reverse.domain.Shipment', 'import mixed.reverse.domain.Shipment as Delivery')
  .replace('Shipment = Shipment("kotlin"', 'Delivery = Delivery("kotlin"')
  .replace('fun shadow()', 'val aliasFactory: (String, Int) -> Delivery = ::Delivery\nfun shadow()')
  .replace(' + "/" + shadow().render())',
    ' + "/" + shadow().render()\n        + "/" + aliasFactory("alias", number).render() + "/" + directFactory("reference", number).render())'));
files.set(factory, [
  'package mixed.reverse.app',
  'import mixed.reverse.domain.Shipment',
  'val directFactory: (String, Int) -> Shipment = ::Shipment',
  ''
].join('\n'));

const evidence = { files: 2, sites: 5, constructorBindings: 3, compilerVerified: true,
  importAliases: 1, retainedAliasSites: 4, constructorReferences: 2 };
const expectedOutput = 'kotlin:42/java:42/shadow/alias:42/reference:42';

function renamedKotlin(text) {
  return text.replace(/(?<!reverse\.shadow\.)\bShipment\b/gu, base.newName);
}

module.exports = {
  ...base, files, factory, evidence, renamedKotlin,
  populate: (root, tools, options) => base.populate(root,tools,{ ...options, units:files }),
  readDatabase: (root, tools, config, engine) => base.readDatabase(root,tools,config,engine,expectedOutput)
};
