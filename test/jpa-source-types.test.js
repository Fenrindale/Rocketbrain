'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {analyzeJPA}=require('../src/jpa/model');
const file=(name,text)=>({uri:'file:///'+name+'.java',text});
const person=file('Person','package demo; import jakarta.persistence.*; @Entity class Person { @Id Long id; String name; }');
test('known same-package entity references win over java.util wildcard imports and bind query domain types',()=>{
  const owner=file('Owner','package demo; import java.util.*; import jakarta.persistence.*; @Entity @NamedQuery(name="owner",query="select o.person.name from Owner o") class Owner { @Id Long id; @ManyToOne Person person; }');
  const model=analyzeJPA([person,owner],{physicalNaming:'standard'}),relation=model.entities.find(e=>e.name==='Owner').attributes.find(a=>a.name==='person');
  assert.equal(relation.targetFqn,'demo.Person');assert.equal(model.queries[0].status,'known');assert.equal(model.queries[0].typeAnalysis.state,'known');assert.equal(model.queries[0].typeAnalysis.selectionTypes[0].javaType,'java.lang.String');
});
test('an explicit import or fully qualified member type is never rebound to a same-package class',()=>{
  for(const member of ['import elsewhere.Person; @ManyToOne Person person;','@ManyToOne elsewhere.Person person;']){
    const imports=member.startsWith('import')?member.slice(0,member.indexOf(';')+1):'',field=member.slice(imports.length);
    const model=analyzeJPA([person,file('Owner','package demo; import java.util.*; import jakarta.persistence.*; '+imports+' @Entity class Owner { @Id Long id; '+field+' }')]);
    const relation=model.entities.find(e=>e.name==='Owner').attributes.find(a=>a.name==='person');assert.equal(relation.targetFqn,'elsewhere.Person');assert.equal(relation.status,'unknown');
  }
});
