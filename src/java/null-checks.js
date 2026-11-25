'use strict';

const {validIdentifier}=require('./file-templates');

const PROFILES=Object.freeze({
  disabled:{label:'Disabled'},
  jspecify:{label:'JSpecify',nullable:'org.jspecify.annotations.Nullable',nonnull:'org.jspecify.annotations.NonNull',
    nonnullByDefault:'org.jspecify.annotations.NullMarked'},
  eclipse:{label:'Eclipse',nullable:'org.eclipse.jdt.annotation.Nullable',nonnull:'org.eclipse.jdt.annotation.NonNull',
    nonnullByDefault:'org.eclipse.jdt.annotation.NonNullByDefault'},
  spring:{label:'Spring annotations',nullable:'org.springframework.lang.Nullable',nonnull:'org.springframework.lang.NonNull',
    nonnullByDefault:'org.springframework.lang.NonNullApi'},
  jetbrains:{label:'JetBrains annotations',nullable:'org.jetbrains.annotations.Nullable',nonnull:'org.jetbrains.annotations.NotNull'},
  custom:{label:'Custom annotations'}
});
const qualified=value=>typeof value==='string'&&value.length<=320&&value.includes('.')&&value.split('.').every(part=>validIdentifier(part));

function resolveNullChecks(config={}) {
  if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Choose a Java null-check annotation profile.');
  const profile=config.profile??'disabled';
  if(!Object.hasOwn(PROFILES,profile))throw Error('Choose a known Java null-check annotation profile.');
  if(profile==='disabled')return {profile,mode:'disabled',nullable:[],nonnull:[],nonnullbydefault:[]};
  const selected=profile==='custom'?config:PROFILES[profile];
  const {nullable,nonnull,nonnullByDefault}=selected;
  if(!qualified(nullable)||!qualified(nonnull)||nonnullByDefault!==undefined&&!qualified(nonnullByDefault)||
      new Set([nullable,nonnull,...(nonnullByDefault?[nonnullByDefault]:[])]).size!==(nonnullByDefault?3:2)) {
    throw Error('Use distinct, fully qualified Java annotation names for nullable, non-null and optional non-null defaults.');
  }
  return {profile,mode:'automatic',nullable:[nullable],nonnull:[nonnull],nonnullbydefault:nonnullByDefault?[nonnullByDefault]:[]};
}

function nullCheckUpdates(settings,next) {
  const current=settings.java.compile.nullAnalysis, upcoming=next.java.compile.nullAnalysis;
  if(JSON.stringify(current)===JSON.stringify(upcoming))return [];
  // JDT LS 1.63 compares mode and the two primary annotation lists on a configuration change.
  const {nonnullbydefault:previousDefault,...previous}=current;
  const {nonnullbydefault:newDefault,...changed}=upcoming;
  if(upcoming.mode==='automatic'&&JSON.stringify(previous)===JSON.stringify(changed)) {
    return [{java:{...next.java,compile:{...next.java.compile,nullAnalysis:{...upcoming,mode:'disabled'}}}},next];
  }
  return [next];
}

module.exports={PROFILES,qualified,resolveNullChecks,nullCheckUpdates};
