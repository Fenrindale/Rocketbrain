'use strict';

const {isDeepStrictEqual}=require('node:util');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const types=new Set(['null','boolean','object','array','number','integer','string']);
const compositions=['allOf','oneOf','anyOf'];

function mergeObjects(parts) {
  if (parts.some(part=>part.kind!=='object'||!part.typeDeclared||part.additional!==undefined||part.constraints?.length)) {
    return undefined;
  }
  const fields=new Map();
  for (const part of parts) for (const field of part.fields) {
    const prior=fields.get(field.name);
    if (prior&&!isDeepStrictEqual(prior.schema,field.schema)) return undefined;
    fields.set(field.name,{...field,required:field.required||prior?.required||false});
  }
  return {kind:'object',typeDeclared:true,fields:[...fields.values()]};
}

function schemaDescriptions(resolve) {
  let nodes=0;
  const active=new Set();
  function describe(input,frame,depth=0) {
    if (++nodes>20000||depth>16) return {kind:'limit'};
    if (typeof input==='boolean') return {kind:'rule',accepts:input};
    const {value,frame:declared}=resolve(input,frame,{schema:true});
    if (active.has(value)) return {kind:'recursive'};
    active.add(value);
    try {
      const constraints=['not','if','then','else','dependentRequired','dependentSchemas','contains','patternProperties',
        'unevaluatedProperties','prefixItems','minimum','maximum','pattern','enum','const','format','minLength',
        'maxLength','minItems','maxItems','minProperties','maxProperties'].filter(key=>Object.hasOwn(value,key));
      const declaredTypes=Array.isArray(value.type)?value.type:[value.type];
      if (declaredTypes.length>7||declaredTypes.some(type=>type!==undefined&&!types.has(type))) {
        throw Error('Use known JSON types in the OpenAPI schema.');
      }
      const selected=declaredTypes[0];
      let base;
      if (declaredTypes.length>1) {
        base={kind:'types',types:declaredTypes};
      } else if (selected==='object'||!selected&&object(value.properties)) {
        const properties=object(value.properties)?Object.entries(value.properties):[];
        const required=value.required??[];
        if (properties.length>80||!Array.isArray(required)||required.length>80||
            required.some(name=>typeof name!=='string'||name.length>120)) {
          throw Error('Describe at most 80 JSON object properties and required names.');
        }
        const mandatory=new Set(required);
        const fields=properties.map(([name,schema])=>{
          if (name.length>120||/[\x00-\x1f\x7f]/.test(name)) throw Error('Use printable JSON property names up to 120 characters.');
          return {name,required:mandatory.delete(name),schema:describe(schema,declared,depth+1)};
        });
        for (const name of mandatory) fields.push({name,required:true,schema:{kind:'unspecified'}});
        base={kind:'object',typeDeclared:selected==='object',fields};
        if (value.additionalProperties!==undefined) {
          base.additional=describe(value.additionalProperties,declared,depth+1);
        }
      } else if (selected==='array'||!selected&&value.items!==undefined) {
        base={kind:'array',typeDeclared:selected==='array',
          items:value.items===undefined?{kind:'unspecified'}:describe(value.items,declared,depth+1)};
      } else {
        base=selected?{kind:'type',type:selected}:{kind:'unspecified'};
      }
      if (constraints.length) base.constraints=constraints;
      const parts=base.kind==='unspecified'&&!constraints.length?[]:[base];
      for (const operator of compositions) if (value[operator]!==undefined) {
        const input=value[operator];
        if (!Array.isArray(input)||!input.length||input.length>12) throw Error('Describe between one and twelve schema alternatives.');
        const alternatives=input.map(child=>describe(child,declared,depth+1));
        const merged=operator==='allOf'?mergeObjects(alternatives):undefined;
        parts.push({kind:operator,parts:alternatives,...(merged&&{merged})});
      }
      if (!parts.length) return base;
      if (parts.length===1) return parts[0];
      const merged=mergeObjects(parts.map(part=>part.merged??part));
      return {kind:'allOf',parts,...(merged&&{merged})};
    } finally { active.delete(value); }
  }
  return (input,frame)=>describe(input,frame);
}

function schemaLines(shape) {
  const result=[];
  function line(text,depth) {
    if (result.length<160) result.push('  '.repeat(depth)+text);
  }
  function render(node,depth,caption='') {
    if (result.length>=160) return;
    switch (node.kind) {
      case 'object':
        line(caption+'object'+(!node.typeDeclared?' properties':''),depth);
        for (const child of node.fields) render(child.schema,depth+1,child.name+(child.required?' (required) ':' '));
        if (node.additional) render(node.additional,depth+1,'additional properties ');
        break;
      case 'array':
        line(caption+'array',depth);
        render(node.items,depth+1,'items ');
        break;
      case 'allOf':
      case 'oneOf':
      case 'anyOf':
        line(caption+node.kind,depth);
        if (node.merged) render(node.merged,depth+1,'combined ');
        else for (const part of node.parts) render(part,depth+1);
        break;
      case 'type': line(caption+node.type,depth); break;
      case 'types': line(caption+node.types.join(' | '),depth); break;
      case 'rule': line(caption+(node.accepts?'any value':'no value'),depth); break;
      case 'recursive': line(caption+'recursive reference',depth); break;
      case 'limit': line(caption+'schema display limit',depth); break;
      default: line(caption+'type unspecified',depth);
    }
    if (node.constraints?.length) line('Declared constraints '+node.constraints.join(', '),depth+1);
  }
  render(shape,0);
  return result;
}

module.exports={schemaDescriptions,schemaLines};
