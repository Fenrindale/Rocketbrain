package rocketbrain.observer;

import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class PersistenceContextRuntime {
    private static final int CONTEXT_LIMIT=16, FACTORY_LIMIT=4, CLASS_LIMIT=512, MANAGED_LIMIT=128, CLASS_BYTES=262144;
    private static final String JAVA_PART="[A-Za-z_$][A-Za-z0-9_$]{0,127}";
    private static final String CONTAINER_FACTORY="org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean";
    private static volatile boolean enabled;
    private static volatile List<String> prefixes=List.of();
    private static final List<Context> contexts=new ArrayList<>();
    private static final List<Owner> owners=new ArrayList<>();
    private static final List<UnitInfo> unitNames=new ArrayList<>();
    private static final List<Definition> definitions=new ArrayList<>();
    private static long contextOrdinal;
    private static boolean omitted;

    private PersistenceContextRuntime(){}

    static synchronized void configure(boolean enabledFlag,Object selected){
        List<String> scopes=new ArrayList<>();
        if(selected!=null){
            if(!(selected instanceof List<?> list)||list.size()>4)throw new IllegalArgumentException("Invalid application package selection");
            for(Object value:list){
                if(!(value instanceof String prefix)||prefix.length()>160||!prefix.matches(JAVA_PART+"(?:\\."+JAVA_PART+"){1,7}")||
                    scopes.contains(prefix+"."))
                    throw new IllegalArgumentException("Invalid application package selection");
                scopes.add(prefix+".");
            }
        }
        if(!enabledFlag&&!scopes.isEmpty())throw new IllegalArgumentException("Enable Spring persistence context inspection first");
        prefixes=List.copyOf(scopes);
        enabled=enabledFlag;
        if(!enabled){
            contexts.clear();owners.clear();unitNames.clear();definitions.clear();
            contextOrdinal=0;omitted=false;
        }
    }

    static boolean enabled(){return enabled;}

    private static final class Context {
        final String key;
        final WeakReference<Object> instance, beanFactory;
        boolean ready, hadParent;
        WeakReference<Object> parent;
        String id;
        Context(Object instance,Object beanFactory,String id,Object parent){
            this.key="context-"+ ++contextOrdinal;
            this.instance=new WeakReference<>(instance);
            this.beanFactory=new WeakReference<>(beanFactory);
            metadata(id,parent);
        }
        void metadata(String id,Object parent){
            this.id=label(id);
            this.hadParent=parent!=null;
            this.parent=new WeakReference<>(parent);
        }
    }
    private record Owner(String id,WeakReference<Object> factory,WeakReference<Object> beans,String beanName,String unitName,boolean ambiguous){}
    private record UnitInfo(WeakReference<Object> instance,String name){}
    private record Definition(String javaType,WeakReference<ClassLoader> loader,String sha256){}
    private record ContextFrame(String key,String id,String parentState,String parentKey,List<LiveOwner> owners){}
    private record LiveOwner(Owner owner,Object instance){}

    private static String label(String value){
        return value!=null&&value.matches("[A-Za-z0-9_.$:@ -]{1,180}")&&!value.isBlank()?value:null;
    }
    private static Context findContext(Object instance){
        if(instance!=null)for(Context value:contexts)if(value.instance.get()==instance)return value;
        return null;
    }
    private static void prune(){
        contexts.removeIf(value->value.instance.get()==null||value.beanFactory.get()==null);
        owners.removeIf(value->value.factory.get()==null||value.beans.get()==null);
    }

    public static synchronized void contextPrepared(Object instance,Object beans,String id,Object parent){
        try{
            if(!enabled||beans==null)return;
            prune();
            // A refresh on the same object has a new observed local bean-factory identity.
            contexts.removeIf(value->value.instance.get()==instance);
            if(contexts.size()>=CONTEXT_LIMIT){omitted=true;return;}
            contexts.add(new Context(instance,beans,id,parent));
        }catch(Throwable ignored){}
    }
    public static synchronized void contextMetadata(Object instance,String id,Object parent){
        try{Context value=findContext(instance);if(value!=null)value.metadata(id,parent);}
        catch(Throwable ignored){}
    }
    public static synchronized void contextReady(Object instance){
        try{Context value=findContext(instance);if(value!=null)value.ready=true;}
        catch(Throwable ignored){}
    }
    public static synchronized void contextClosed(Object instance){
        try{contexts.removeIf(value->value.instance.get()==instance);}
        catch(Throwable ignored){}
    }
    static synchronized void factoryClosed(Object instance){
        try{owners.removeIf(value->value.factory.get()==instance);}
        catch(Throwable ignored){}
    }

    private static Object declaredGetter(Object instance,String declaringClass,String getter)throws ReflectiveOperationException{
        if(instance==null)return null;
        Method method=instance.getClass().getMethod(getter);
        return method.getDeclaringClass().getName().equals(declaringClass)?method.invoke(instance):null;
    }
    public static synchronized void unitNameObserved(Object result,Object unit,Object invocation){
        try{
            if(!enabled||unit==null||!(invocation instanceof Method method)||!method.getName().equals("getPersistenceUnitName")||
                method.getParameterCount()!=0||method.getReturnType()!=String.class||!(result instanceof String value))return;
            String name=label(value);
            if(name==null)return;
            unitNames.removeIf(entry->entry.instance.get()==null);
            for(UnitInfo entry:unitNames)if(entry.instance.get()==unit)return;
            if(unitNames.size()<CONTEXT_LIMIT)unitNames.add(new UnitInfo(new WeakReference<>(unit),name));
        }catch(Throwable ignored){}
    }

    private static synchronized String unitName(Object unit){
        if(unit!=null)for(UnitInfo entry:unitNames)if(entry.instance.get()==unit)return entry.name;
        return null;
    }

    public static void factoryBuilt(Object nativeFactory,Object factoryBean,Object beans,String beanName){
        try{
            if(!enabled||nativeFactory==null||beans==null||
                !nativeFactory.getClass().getName().equals("org.hibernate.internal.SessionFactoryImpl"))return;
            String name=label(beanName);
            Object unit=declaredGetter(factoryBean,CONTAINER_FACTORY,"getPersistenceUnitInfo");
            String unitName=unitName(unit);
            if(name==null||unitName==null)return;
            String id=ObserverRuntime.registerFactory(nativeFactory);
            if(id==null)return;
            synchronized(PersistenceContextRuntime.class){
                prune();
                for(int index=0;index<owners.size();index++){
                    Owner prior=owners.get(index);
                    if(prior.factory.get()!=nativeFactory)continue;
                    if(!prior.ambiguous&&(prior.beans.get()!=beans||!prior.beanName.equals(name)||!prior.unitName.equals(unitName))){
                        owners.set(index,new Owner(prior.id,prior.factory,prior.beans,prior.beanName,prior.unitName,true));
                    }
                    return;
                }
                if(owners.size()>=FACTORY_LIMIT){omitted=true;return;}
                owners.add(new Owner(id,new WeakReference<>(nativeFactory),new WeakReference<>(beans),name,unitName,false));
            }
        }catch(Throwable ignored){}
    }

    static void classDefined(ClassLoader loader,String internalName,byte[] bytes,boolean replaced){
        try{
            if(!enabled||loader==null||internalName==null||prefixes.isEmpty())return;
            String name=internalName.replace('/','.');
            if(prefixes.stream().noneMatch(name::startsWith)||name.length()>256||
                !name.matches(JAVA_PART+"(?:\\."+JAVA_PART+")*"))return;
            synchronized(PersistenceContextRuntime.class){
                definitions.removeIf(value->value.loader.get()==null);
                String digest=replaced||bytes.length>CLASS_BYTES?null:sha(bytes);
                for(int index=0;index<definitions.size();index++){
                    Definition prior=definitions.get(index);
                    if(prior.loader.get()!=loader||!prior.javaType.equals(name))continue;
                    if(prior.sha256!=null&&!prior.sha256.equals(digest))definitions.set(index,new Definition(name,prior.loader,null));
                    return;
                }
                if(definitions.size()<CLASS_LIMIT)definitions.add(new Definition(name,new WeakReference<>(loader),digest));
            }
        }catch(Throwable ignored){}
    }

    private static String sha(byte[] data)throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
    }

    private static Map<String,Object> build(Object factory,List<Definition> captured){
        if(prefixes.isEmpty())return Map.of("state","disabled","classes",List.of());
        try{
            List<Class<?>> types=HibernateAccess.observedManagedClasses(factory,MANAGED_LIMIT);
            if(types==null||types.isEmpty())return Map.of("state","unavailable","classes",List.of());
            List<Map<String,String>> classes=new ArrayList<>();
            StringBuilder manifest=new StringBuilder();
            for(Class<?> type:types){
                String name=type.getName();
                String hash=null;
                for(Definition definition:captured){
                    if(definition.loader.get()==type.getClassLoader()&&definition.javaType.equals(name)){
                        hash=definition.sha256;break;
                    }
                }
                classes.add(hash==null?Map.of("javaType",name):Map.of("javaType",name,"sha256",hash));
                if(hash!=null)manifest.append(name).append(' ').append(hash).append('\n');
            }
            if(classes.stream().anyMatch(row->!row.containsKey("sha256")))return Map.of("state","partial","classes",classes);
            return Map.of("state","known","classes",classes,"fingerprint",sha(manifest.toString().getBytes(StandardCharsets.UTF_8)));
        }catch(Throwable ignored){return Map.of("state","unavailable","classes",List.of());}
    }

    static Map<String,Object> snapshot(List<String> instruments,List<String> liveIds){
        if(!enabled)return Map.of("state","disabled","contexts",List.of(),"unassignedFactoryIds",List.of(),
            "observerExecutedSql",false,"applicationCallbacksInvoked",false);
        List<ContextFrame> frames=new ArrayList<>();
        List<Definition> captured;
        Set<String> assigned=new HashSet<>();
        boolean limited;
        synchronized(PersistenceContextRuntime.class){
            prune();
            for(Context value:contexts){
                if(!value.ready)continue;
                Context parent=findContext(value.parent.get());
                String parentState=!value.hadParent?"root":parent!=null&&parent.ready?"observed":"unobserved";
                Object beans=value.beanFactory.get();
                List<LiveOwner> members=new ArrayList<>();
                for(Owner row:owners){
                    Object factory=row.factory.get();
                    if(row.ambiguous||factory==null||beans==null||row.beans.get()!=beans||!liveIds.contains(row.id))continue;
                    members.add(new LiveOwner(row,factory));
                    assigned.add(row.id);
                }
                frames.add(new ContextFrame(value.key,value.id,parentState,parentState.equals("observed")?parent.key:null,members));
            }
            captured=List.copyOf(definitions);
            limited=omitted;
        }
        List<Map<String,Object>> displayed=new ArrayList<>();
        for(ContextFrame value:frames){
            Map<String,Object> context=new LinkedHashMap<>();
            context.put("key",value.key);
            if(value.id!=null)context.put("id",value.id);
            context.put("parentState",value.parentState);
            if(value.parentKey!=null)context.put("parentKey",value.parentKey);
            context.put("factories",value.owners.stream().map(member->Map.of(
                "factoryId",member.owner.id,"beanName",member.owner.beanName,"persistenceUnit",member.owner.unitName,
                "build",build(member.instance,captured))).toList());
            displayed.add(context);
        }
        List<String> unassigned=liveIds.stream().filter(id->!assigned.contains(id)).toList();
        boolean hooks=instruments.containsAll(List.of(PersistenceContextTransformer.CONTEXT,PersistenceContextTransformer.FACTORY,PersistenceContextTransformer.UNIT_INFO));
        boolean incomplete=limited||!unassigned.isEmpty()||frames.stream().anyMatch(value->value.parentState.equals("unobserved"));
        return Map.of("state",!hooks?"awaiting-hooks":incomplete?"partial":"observed",
            "contexts",displayed,"unassignedFactoryIds",unassigned,
            "observerExecutedSql",false,"applicationCallbacksInvoked",false);
    }
}
