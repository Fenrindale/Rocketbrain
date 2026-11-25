package rocketbrain.observer;

import static rocketbrain.observer.HibernateAccess.invoke;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Inspects a single Hibernate fetch path and reads only provider-confirmed field state. */
final class ConsoleFetchSnapshot {
    static final int MAX_ROOTS=25, MAX_CHILDREN=16, MAX_JOINED_ROWS=512;
    private static final int MAX_FIELDS=8;
    private static final String SELECT="org.hibernate.query.sqm.tree.select.";
    private static final String COLLECTION="org.hibernate.collection.spi.";
    private static final String FIELD_ERROR="unsupported_fetch_mapping";
    private static final Set<String> ASSOC=Set.of("ONE_TO_MANY","MANY_TO_MANY","ONE_TO_ONE","MANY_TO_ONE");
    private static final Set<String> RAW_COLLECTION=Set.of("java.util.ArrayList","java.util.LinkedList","java.util.HashSet","java.util.LinkedHashSet");
    private static final Set<String> FIELD_GETTERS=Set.of("org.hibernate.property.access.spi.GetterFieldImpl","org.hibernate.property.access.spi.EnhancedGetterFieldImpl");
    private static final Set<String> INSTANTIATORS=Set.of("org.hibernate.metamodel.internal.EntityInstantiatorPojoStandard","org.hibernate.metamodel.internal.EntityInstantiatorPojoOptimized");
    private static final Set<String> PERSISTERS=Set.of("org.hibernate.persister.entity.SingleTableEntityPersister",
        "org.hibernate.persister.entity.JoinedSubclassEntityPersister","org.hibernate.persister.entity.UnionSubclassEntityPersister");
    private static final Set<String> BASIC_TYPES=Set.of("org.hibernate.type.internal.BasicTypeImpl","org.hibernate.type.internal.NamedBasicTypeImpl",
        "org.hibernate.type.internal.ImmutableNamedBasicTypeImpl","org.hibernate.type.internal.PrimitiveBasicTypeImpl");
    private static final Map<String,String> WRAPPERS=Map.of(COLLECTION+"PersistentBag","collection",COLLECTION+"PersistentList","list",COLLECTION+"PersistentSet","set");
    private static final Map<String,String> BOXES=Map.of("long","java.lang.Long","int","java.lang.Integer","short","java.lang.Short","byte","java.lang.Byte",
        "boolean","java.lang.Boolean","double","java.lang.Double","float","java.lang.Float");

    record Clause(String projection,String attribute,String kind) {}
    record Cell(String name,String javaType,Field field,boolean id) {
        Map<String,Object> column(){return Map.of("alias",name,"javaType",javaType);}
    }
    record Entity(Class<?> type,List<Cell> fields) {
        List<Map<String,Object>> columns(){return fields.stream().map(Cell::column).toList();}
    }
    record Plan(Entity owner,Field association,Entity target,boolean toMany,Method isInitialized,Method wasPropertyInitialized) {
        Map<String,Object> describe(){
            return Map.of("rootType",owner.type().getName(),"association",association.getName(),"path",owner.type().getName()+'.'+association.getName(),
                "targetType",target.type().getName(),"toMany",toMany,"columns",target.columns(),"maxRoots",MAX_ROOTS,"maxChildren",MAX_CHILDREN);
        }
    }

    private ConsoleFetchSnapshot() {}

    static Clause clause(List<String> words) {
        long fetches=words.stream().filter("fetch"::equals).count();
        if(fetches!=1 || !at(words,0).equals("select") || words.stream().filter("select"::equals).count()!=1) return null;
        int index=at(words,1).equals("distinct")?2:1;
        String alias=at(words,index++);
        if(!name(alias) || !at(words,index++).equals("from") || !name(at(words,index++))) return null;
        while(at(words,index).equals(".") && name(at(words,index+1))) index+=2;
        if(at(words,index).equals("as"))index++;
        if(!at(words,index++).equals(alias))return null;
        String kind="INNER";
        if(at(words,index).equals("left")) {
            kind="LEFT"; index++;
            if(at(words,index).equals("outer"))index++;
        } else if(at(words,index).equals("inner")) index++;
        if(!at(words,index++).equals("join") || !at(words,index++).equals("fetch") ||
            !at(words,index++).equals(alias) || !at(words,index++).equals("."))return null;
        String attribute=at(words,index++);
        if(!name(attribute) || index<words.size() && !Set.of("where","order").contains(at(words,index)))return null;
        if(words.stream().filter("join"::equals).count()!=1)return null;
        return new Clause(alias,attribute,kind);
    }

    static Plan inspect(Object factory,Object statement,Clause clause) throws Throwable {
        ClassLoader loader=factory.getClass().getClassLoader();
        Class<?> version=Class.forName("org.hibernate.Version",false,loader);
        if(!(version.getMethod("getVersionString").invoke(null) instanceof String release) || !release.startsWith("7.4."))
            throw new ConsoleQuery.Refusal("unsupported_fetch_provider");
        if(statement==null || !statement.getClass().getName().equals(SELECT+"SqmSelectStatement"))
            throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        Object spec=invoke(statement,"getQueryPart");
        if(!spec.getClass().getName().equals(SELECT+"SqmQuerySpec") || !items(invoke(statement,"getCteStatements"),0).isEmpty())
            throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        Object root=one(invoke(invoke(spec,"getFromClause"),"getRoots"));
        Object selection=one(invoke(invoke(spec,"getSelectClause"),"getSelections"));
        if(invoke(selection,"getSelectableNode")!=root || !(invoke(root,"getExplicitAlias") instanceof String alias) ||
            !alias.equalsIgnoreCase(clause.projection()))throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        Object join=one(invoke(root,"getSqmJoins"));
        if(!Boolean.TRUE.equals(invoke(join,"isFetched")) || !clause.kind().equals(((Enum<?>)invoke(join,"getSqmJoinType")).name()) ||
            !items(invoke(join,"getSqmJoins"),0).isEmpty()) throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        Object attribute=invoke(join,"getAttribute");
        String name=(String)invoke(attribute,"getName");
        if(!name.equalsIgnoreCase(clause.attribute()) || !Boolean.TRUE.equals(invoke(attribute,"isAssociation")) ||
            !ASSOC.contains(((Enum<?>)invoke(attribute,"getPersistentAttributeType")).name()))
            throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        boolean many=Boolean.TRUE.equals(invoke(attribute,"isCollection"));
        Class<?> ownerClass=(Class<?>)invoke(invoke(root,"getModel"),"getJavaType");
        Class<?> targetClass=(Class<?>)invoke(many?invoke(attribute,"getElementType"):attribute,"getJavaType");
        Field member=field(attribute,ownerClass);
        if(many && !Set.of(Collection.class,List.class,Set.class).contains(member.getType()) ||
            !many && member.getType()!=targetClass) throw new ConsoleQuery.Refusal(FIELD_ERROR);
        Object events=invoke(factory,"getEventEngine");
        requireDefaultListeners(events,loader,"PRE_LOAD","DefaultPreLoadEventListener");
        requireDefaultListeners(events,loader,"POST_LOAD","DefaultPostLoadEventListener");
        Class<?> hibernate=Class.forName("org.hibernate.Hibernate",false,loader);
        return new Plan(entity(factory,events,ownerClass,loader,name),member,entity(factory,events,targetClass,loader,null),many,
            hibernate.getMethod("isInitialized",Object.class),hibernate.getMethod("isPropertyInitialized",Object.class,String.class));
    }

    private static void requireDefaultListeners(Object events,ClassLoader loader,String event,String listener) throws Throwable {
        Object kind=Class.forName("org.hibernate.event.spi.EventType",false,loader).getField(event).get(null);
        Object group=invoke(invoke(events,"getListenerRegistry"),"getEventListenerGroup",kind);
        if(!(invoke(group,"listeners") instanceof Iterable<?> listeners))throw new ConsoleQuery.Refusal("custom_fetch_lifecycle");
        int count=0;
        for (Object entry:listeners)
            if(++count>1 || !entry.getClass().getName().equals("org.hibernate.event.internal."+listener))
                throw new ConsoleQuery.Refusal("custom_fetch_lifecycle");
    }

    private static Entity entity(Object factory,Object events,Class<?> type,ClassLoader loader,String requestedAssociation) throws Throwable {
        Object callback=Class.forName("org.hibernate.jpa.event.spi.CallbackType",false,loader).getField("POST_LOAD").get(null);
        Object registry=invoke(events,"getCallbackRegistry");
        if(!Boolean.FALSE.equals(invoke(registry,"hasRegisteredCallbacks",type,callback)))
            throw new ConsoleQuery.Refusal("custom_fetch_lifecycle");
        Object entity=invoke(invoke(factory,"getMetamodel"),"entity",type);
        Object persister=invoke(invoke(factory,"getMappingMetamodel"),"getEntityDescriptor",type);
        if(!PERSISTERS.contains(persister.getClass().getName()))throw new ConsoleQuery.Refusal(FIELD_ERROR);
        if(!Boolean.FALSE.equals(invoke(persister,"hasSubclasses")))throw new ConsoleQuery.Refusal("custom_fetch_lifecycle");
        Object instantiator=invoke(invoke(persister,"getRepresentationStrategy"),"getInstantiator");
        if(!INSTANTIATORS.contains(instantiator.getClass().getName()) || type.getMethod("equals",Object.class).getDeclaringClass()!=Object.class ||
            type.getMethod("hashCode").getDeclaringClass()!=Object.class)throw new ConsoleQuery.Refusal(FIELD_ERROR);
        List<Cell> columns=new ArrayList<>();
        for(Object attribute:items(invoke(entity,"getAttributes"),32)){
            Field member=field(attribute,type);
            String classification=((Enum<?>)invoke(attribute,"getPersistentAttributeType")).name();
            String name=(String)invoke(attribute,"getName");
            if(ASSOC.contains(classification)){
                Object part=invoke(persister,"findAttributeMapping",name);
                requireFieldMapping(part,member);
                if(!name.equals(requestedAssociation) && !"DELAYED".equals(((Enum<?>)invoke(invoke(part,"getMappedFetchOptions"),"getTiming")).name()))
                    throw new ConsoleQuery.Refusal("additional_eager_fetch");
                continue;
            }
            if(!classification.equals("BASIC"))throw new ConsoleQuery.Refusal(FIELD_ERROR);
            String javaType=BOXES.getOrDefault(member.getType().getName(),member.getType().getName());
            if(!ConsoleQuery.safeType(javaType) || columns.size()>=MAX_FIELDS)throw new ConsoleQuery.Refusal(FIELD_ERROR);
            boolean id=Boolean.TRUE.equals(invoke(attribute,"isId"));
            Object part=id?invoke(persister,"getIdentifierMapping"):invoke(persister,"findAttributeMapping",name);
            requireFieldMapping(part,member);
            Object jdbc=invoke(part,"getJdbcMapping");
            Object jdbcType=invoke(jdbc,"getJdbcType");
            if(!BASIC_TYPES.contains(jdbc.getClass().getName()) || invoke(jdbc,"getValueConverter")!=null ||
                !invoke(jdbc,"getJdbcJavaType").getClass().getName().startsWith("org.hibernate.type.descriptor.java.") ||
                !jdbcType.getClass().getName().startsWith("org.hibernate.type.descriptor.jdbc.") ||
                !Boolean.FALSE.equals(invoke(jdbcType,"isLobOrLong")))
                throw new ConsoleQuery.Refusal(FIELD_ERROR);
            columns.add(new Cell(name,javaType,member,id));
        }
        if(columns.stream().filter(Cell::id).count()!=1)throw new ConsoleQuery.Refusal(FIELD_ERROR);
        columns.sort(Comparator.comparing(Cell::id).reversed().thenComparing(Cell::name));
        return new Entity(type,List.copyOf(columns));
    }

    private static void requireFieldMapping(Object part,Field member) throws Throwable {
        Object getter=invoke(invoke(part,"getPropertyAccess"),"getGetter");
        if(!FIELD_GETTERS.contains(getter.getClass().getName()) || !member.equals(invoke(getter,"getMember")))
            throw new ConsoleQuery.Refusal(FIELD_ERROR);
    }

    private static Field field(Object attribute,Class<?> type) throws Throwable {
        if(!(invoke(attribute,"getJavaMember") instanceof Field member) || !member.getDeclaringClass().isAssignableFrom(type) ||
            Modifier.isStatic(member.getModifiers()) || !member.trySetAccessible())throw new ConsoleQuery.Refusal(FIELD_ERROR);
        return member;
    }

    static Map<String,Object> rows(Plan plan,List<?> values,int limit,int joinedRows) throws ReflectiveOperationException {
        var budget=new ConsoleQuery.ResultBudget();
        List<List<Object>> roots=new ArrayList<>();
        List<Map<String,Object>> linked=new ArrayList<>();
        for(Object root:values){
            if(roots.size()>=limit)break;
            roots.add(cells(plan,plan.owner(),root,budget));
            Field field=plan.association();
            initialized(plan,root,field.getName());
            Object association=field.get(root);
            if(!plan.toMany()){
                linked.add(Map.of("state",association==null?"null":"loaded","rows",association==null?List.of():List.of(cells(plan,plan.target(),association,budget)),"hasMore",false));
                continue;
            }
            Collection<?> children=collection(plan,association);
            List<List<Object>> items=new ArrayList<>();
            for(Object child:children){
                if(items.size()>=MAX_CHILDREN)break;
                items.add(cells(plan,plan.target(),child,budget));
            }
            linked.add(Map.of("state","loaded","rows",items,"hasMore",children.size()>MAX_CHILDREN));
        }
        Map<String,Object> response=ConsoleQuery.completed(plan.owner().columns(),roots,values.size()>limit);
        Map<String,Object> fetch=new LinkedHashMap<>(plan.describe());
        fetch.put("linked",linked); fetch.put("joinedRows",joinedRows);
        response.put("fetchSnapshot",fetch);
        return response;
    }

    private static Collection<?> collection(Plan plan,Object value) throws ReflectiveOperationException {
        if(value==null || !Boolean.TRUE.equals(plan.isInitialized().invoke(null,value)))throw new ConsoleQuery.Refusal("fetch_not_initialized");
        String wrapper=WRAPPERS.get(value.getClass().getName());
        if(wrapper==null) throw new ConsoleQuery.Refusal(FIELD_ERROR);
        Field backing=value.getClass().getDeclaredField(wrapper);
        if(!backing.trySetAccessible())throw new ConsoleQuery.Refusal(FIELD_ERROR);
        Object raw=backing.get(value);
        if(!(raw instanceof Collection<?> items) || !RAW_COLLECTION.contains(raw.getClass().getName()))
            throw new ConsoleQuery.Refusal(FIELD_ERROR);
        return items;
    }

    private static List<Object> cells(Plan plan,Entity entity,Object value,ConsoleQuery.ResultBudget budget) throws ReflectiveOperationException {
        if(value==null || value.getClass()!=entity.type() || !Boolean.TRUE.equals(plan.isInitialized().invoke(null,value)))
            throw new ConsoleQuery.Refusal("fetch_not_initialized");
        List<Object> cells=new ArrayList<>();
        for(Cell cell:entity.fields()){
            initialized(plan,value,cell.field().getName());
            cells.add(budget.scalar(cell.field().get(value),cell.javaType()));
        }
        return cells;
    }

    private static void initialized(Plan plan,Object value,String field) throws ReflectiveOperationException {
        if(!Boolean.TRUE.equals(plan.wasPropertyInitialized().invoke(null,value,field)))throw new ConsoleQuery.Refusal("fetch_not_initialized");
    }

    private static Collection<?> items(Object value,int max){
        if(!(value instanceof Collection<?> list) || list.size()>max)throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        return list;
    }
    private static Object one(Object value){
        Collection<?> list=items(value,1);
        if(list.size()!=1)throw new ConsoleQuery.Refusal("unsupported_fetch_shape");
        return list.iterator().next();
    }
    private static String at(List<String> words,int index){return index>=words.size()?"":words.get(index);}
    private static boolean name(String value){return value.matches("[a-z_][a-z0-9_]{0,127}");}
}
