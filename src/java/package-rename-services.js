'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lexJava } = require('../spring/java');
const { reviewPackageServices } = require('./package-services');
const resources = require('./package-resources');
const { proveLocalBuildMapping, proveClasspathPaths } = require('./package-classpath');

const mainResources = ['src', 'main', 'resources'];
const modelFiles = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties']);

async function reviewRenamedPackageServices({ scope, sources, moved, tree, oldPackage, newPackage, uriFor }) {
  const project = scope.source.root;
  const directoryExists = resources.resourceDirectoryInsideProject;
  if (!directoryExists(project, [...mainResources, 'META-INF', 'services'])) return undefined;
  const roots = [path.join(project, ...mainResources)];
  const renames = [...moved.values()];
  const services = reviewPackageServices({ project, roots, directoryExists, sources,
    moved: new Map(renames.map(item => [item.oldUri, item])), oldPackage, newPackage, uriFor });
  if (services.module) throw Error('Package Rename supports classpath ServiceLoader registrations in the standard main source set.');
  if (!services.services.size) return undefined;
  const config = resources.resourceRoots(project, { sourceRoots: scope.source.sourceRoots });
  if (path.relative(path.join(project, 'src/main/java'), scope.source.sourceRoot) ||
      config.roots.length !== 1 || path.relative(roots[0], config.roots[0])) {
    throw Error('Package Rename service registrations require the standard main Java and resource roots.');
  }
  proveLocalBuildMapping(project, config, scope.buildFiles.filter(file => modelFiles.has(path.basename(file))));
  const identities = new Map(), classFile = name => name.replaceAll('.', '/') + '.class';
  for (const descriptor of services.services.values()) {
    identities.set(descriptor.path, { sha256: descriptor.sha256 });
    if (descriptor.path !== descriptor.newPath) {
      identities.set(descriptor.newPath, null);
      identities.set(classFile(descriptor.nextService), null);
    }
    identities.set(classFile(descriptor.service), { classFile: true });
    for (const provider of descriptor.providers) identities.set(classFile(provider), { classFile: true });
    for (const changed of descriptor.rewrites) identities.set(classFile(changed.to), null);
  }
  const observed = () => [...new Set([...scope.source.classpaths.classpaths.filter(file => fs.existsSync(file)), ...roots])];
  const classpaths = observed();
  const classpath = await proveClasspathPaths(classpaths, project, roots, identities);
  const clients = sources.filter(source => source.file.endsWith('.java') &&
    lexJava(source.text).tokens.some(token => token.text === 'ServiceLoader'));
  const lookups = resources.reviewLookups(clients, { files: tree.files.map(file => ({ file })) },
    { files: [] }, oldPackage, newPackage, services.services);
  return {
    ...services,
    reviewedFiles: new Set(services.permissions.map(permission => permission.uri)),
    reviewedClients: new Set(lookups.serviceCalls.map(client => client.uri)),
    receipt: { descriptors: services.permissions.length, renamedDescriptors: services.renames.length,
      providerNames: [...services.services.values()].reduce((count, descriptor) => count + descriptor.rewrites.length, 0),
      compilerContracts: services.compilerContractCount, loaderCalls: lookups.serviceCalls.length, classpath: classpath.proof },
    verify(before, after, prospective, edits) {
      services.verifyProviders(prospective, renames);
      resources.verifyServiceClients(lookups.serviceCalls, prospective, renames, services.services);
      resources.verifyResourceBindings(lookups.bindings, sources, edits, renames, before, after);
      services.verifyCompilerBindings(before, after, renames);
    },
    validate() {
      services.validate();
      if (JSON.stringify(observed()) !== JSON.stringify(classpaths)) throw Error('The ServiceLoader classpath changed after Package Rename review.');
      classpath.validate();
    }
  };
}

module.exports = { reviewRenamedPackageServices };
