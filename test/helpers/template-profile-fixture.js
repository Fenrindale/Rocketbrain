'use strict';

const variables=[
  {name:'method',kind:'identifier',prompt:'Method name',default:'message'},
  {name:'label',kind:'string',prompt:'Java string value'},
  {name:'count',kind:'integer',prompt:'Repeat count',default:'007'}
];
const body=annotation=>[
  '${packageDeclaration}'+(annotation?'@org.springframework.stereotype.Component\n':'')+'public class ${name} {',
  '    public static String ${variable.method}() { return ${variable.label} + ":" + ${variable.count}; }',
  '    public static void main(String[] args) { System.out.print(${variable.method}()); }',
  '}',''
].join('\n');
const template=(tool,source,{spring=false}={})=>({
  name:tool+' '+source+' component',source,buildTools:[tool],variables,template:body(spring)
});
const profile=(tool,source)=>({name:tool+' '+source+' notice',source,buildTools:[tool],
  notice:'Copyright ${year} Fixture contributors\n${package}.${name} · '+tool});

module.exports={template,profile};
