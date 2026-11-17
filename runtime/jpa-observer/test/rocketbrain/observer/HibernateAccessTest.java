package rocketbrain.observer;
import java.util.*;

/** Dependency-free contract tests: no database, Hibernate binary or network. */
public class HibernateAccessTest {
    private static int checks;
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    @SuppressWarnings("unchecked") static List<Map<String,Object>> list(Map<String,Object> value,String key) { return (List<Map<String,Object>>)value.get(key); }
    public static void main(String[] args) {
        Factory factory=new Factory();
        check("unknown".equals(HibernateAccess.snapshot(null).get("state")),"missing factory is unknown");
        check("unknown".equals(HibernateAccess.analyze(factory, " ").get("state")),"blank query rejected");
        check(factory.engine.translator.calls==0,"bounds do not call translator");
        Map<String,Object> result=HibernateAccess.analyze(factory,"select p.name, p.id from Person p where p.id=:id");
        check("known".equals(result.get("state")),"successful semantic statement known");
        check("java.lang.String".equals(list(result,"selectionTypes").get(0).get("javaType")),"selection String observed");
        check("java.lang.Long".equals(list(result,"selectionTypes").get(1).get("javaType")),"selection Long observed");
        check(list(result,"parameters").size()==1,"repeated parameter deduplicated");
        check("id".equals(list(result,"parameters").getFirst().get("name")),"parameter name observed");
        check("java.lang.Long".equals(list(result,"parameters").getFirst().get("javaType")),"parameter type observed");
        check(Boolean.FALSE.equals(result.get("sqlExecuted"))&&factory.sessions==0,"no session opened or SQL executed");
        Map<String,Object> failed=HibernateAccess.analyze(factory,"secret-input");
        check("unknown".equals(failed.get("state")),"unexpected provider error is not invalid proof");
        check(!failed.toString().contains("password-value"),"raw provider messages do not leak literals");
        Map<String,Object> snapshot=HibernateAccess.snapshot(factory);
        check("observed".equals(snapshot.get("state")),"public metamodel snapshot observed");
        check(list(snapshot,"entities").size()==1,"one managed entity");
        Map<String,Object> entity=list(snapshot,"entities").getFirst();
        check("person_table".equals(entity.get("table")),"physical table from provider");
        check(list(entity,"tableKeys").size()==1,"physical table keys from provider");
        check(list(entity,"attributes").size()==2,"attribute metadata read");
        check(list(entity,"physicalMappings").size()==2,"column mappings read");
        check("unknown".equals(((Map<?,?>)list(snapshot,"functions").getFirst().get("returns")).get("state")),"display return signature is not a type proof");
        check(factory.sessions==0,"metadata does not open sessions");
        Map<String,Object> dml=HibernateAccess.describeStatement(new SqmUpdateStatement());
        check("update".equals(dml.get("statementKind"))&&"known".equals(dml.get("state")),"DML metadata needs no execution");
        factory.engine.registry.count=600;
        Map<String,Object> capped=HibernateAccess.snapshot(factory);
        check(Boolean.TRUE.equals(capped.get("truncated")),"registry truncation explicit");
        check(list(capped,"functions").size()<=512,"function count bounded");
        System.out.println("HibernateAccessTest: "+checks+" checks passed");
    }
    public static class Factory { int sessions; final Engine engine=new Engine(); public boolean isClosed(){return false;} public Engine getQueryEngine(){return engine;} public Metamodel getMetamodel(){return new Metamodel();} public Mapping getMappingMetamodel(){return new Mapping();} public Object openSession(){sessions++;throw new AssertionError("must not open session");} }
    public static class Engine { final Translator translator=new Translator();final Registry registry=new Registry(); public Translator getHqlTranslator(){return translator;} public Registry getSqmFunctionRegistry(){return registry;} }
    public static class Translator {int calls; public SqmSelectStatement translate(String hql,Class<?> expected){calls++;if(hql.equals("secret-input"))throw new IllegalStateException("password-value "+hql);return new SqmSelectStatement();} }
    public static class SqmSelectStatement {public Spec getQueryPart(){return new Spec();}public Set<Parameter> getSqmParameters(){return new LinkedHashSet<>(List.of(new Parameter(),new Parameter()));} }
    public static class SqmUpdateStatement {public Set<Parameter> getSqmParameters(){return Set.of();} }
    public static class Spec {public Spec getFirstQuerySpec(){return this;}public Clause getSelectClause(){return new Clause();} }
    public static class Clause {public List<Selection> getSelections(){return List.of(new Selection(String.class),new Selection(Long.class));} }
    public static class Selection {private final Class<?> type;Selection(Class<?> type){this.type=type;}public Selection getSelectableNode(){return this;}public TypeView getNodeJavaType(){return new HiddenType(type);}public String getAlias(){return null;} }
    public interface TypeView {Class<?> getJavaTypeClass();}
    private static class HiddenType implements TypeView {private final Class<?> type;HiddenType(Class<?> type){this.type=type;}public Class<?> getJavaTypeClass(){return type;} }
    public static class Parameter {public String getName(){return "id";}public Integer getPosition(){return null;}public Class<?> getParameterType(){return Long.class;}public boolean allowMultiValuedBinding(){return false;} }
    public static class Metamodel {public Set<Entity> getEntities(){return Set.of(new Entity());} }
    public static class Person {}
    public static class Entity {public String getName(){return "Person";}public Class<?> getJavaType(){return Person.class;}public Set<Attribute> getAttributes(){return Set.of(new Attribute("id",Long.class),new Attribute("name",String.class));} }
    public enum Kind {BASIC}
    public static class Attribute {private final String name;private final Class<?> type;Attribute(String name,Class<?> type){this.name=name;this.type=type;}public String getName(){return name;}public Class<?> getJavaType(){return type;}public Kind getPersistentAttributeType(){return Kind.BASIC;}public boolean isAssociation(){return false;}public boolean isCollection(){return false;} }
    public static class Mapping {public Persister findEntityDescriptor(String name){return new Persister();} }
    public static class Persister {public String getTableName(){return "person_table";}public String[] getTableNames(){return new String[]{"person_table"};}public String[] getIdentifierColumnNames(){return new String[]{"id"};}public String[] getKeyColumns(int index){return new String[]{"id"};}public Column findAttributeMapping(String property){return new Column(property);} }
    public static class Column {private final String name;Column(String name){this.name=name;}public String getSelectionExpression(){return name;}public String getContainingTableExpression(){return "person_table";}public boolean isFormula(){return false;} }
    public static class Registry {int count=1;public Set<String> getValidFunctionKeys(){Set<String> names=new LinkedHashSet<>();for(int i=0;i<count;i++)names.add("custom_"+i);return names;}public FunctionView findFunctionDescriptor(String name){return new HiddenFunction();} }
    public interface FunctionView {String getSignature(String name);String getReturnSignature();Validator getArgumentsValidator();}
    private static class HiddenFunction implements FunctionView {public String getSignature(String name){return "String "+name+"(STRING arg)";}public String getReturnSignature(){return "String";}public Validator getArgumentsValidator(){return new Validator();} }
    public static class Validator {public String getSignature(){return "(STRING arg)";} }
}
