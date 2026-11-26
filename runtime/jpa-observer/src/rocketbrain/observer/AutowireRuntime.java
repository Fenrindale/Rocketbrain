package rocketbrain.observer;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

public final class AutowireRuntime {
    private static final int LIMIT=48, PARAMETER_LIMIT=24, DEPTH_LIMIT=8;
    private static final String FACTORY="org.springframework.beans.factory.support.DefaultListableBeanFactory";
    private static final String DESCRIPTOR="org.springframework.beans.factory.support.ConstructorResolver$ConstructorDependencyDescriptor";
    private static final String MEMBER_DESCRIPTOR="org.springframework.beans.factory.config.DependencyDescriptor";
    private static final String AMBIGUOUS="org.springframework.beans.factory.NoUniqueBeanDefinitionException";
    private static final Set<Class<?>> AGGREGATES=Set.of(List.class,Set.class,Collection.class,Map.class);
    private static final StackWalker CALLERS=StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE);
    private static final ThreadLocal<Frame> active=new ThreadLocal<>();
    private static final ThreadLocal<Frame> ancestorLookup=new ThreadLocal<>();
    private static final ArrayDeque<Map<String,Object>> retained=new ArrayDeque<>();
    private static final ArrayDeque<Map<String,Object>> members=new ArrayDeque<>();
    private static volatile List<String> prefixes=List.of();
    private static volatile boolean enabled;
    private static long sequence, dropped, droppedMembers;

    private AutowireRuntime(){}

    static synchronized void configure(boolean flag,Object selected){
        List<String> scopes=new ArrayList<>();
        if(selected!=null){
            if(!(selected instanceof List<?> list)||list.size()>4)throw new IllegalArgumentException("Invalid constructor trace packages");
            for(Object value:list){
                if(!(value instanceof String prefix)||prefix.length()>160||
                    !prefix.matches("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*){1,7}")||scopes.contains(prefix+"."))
                    throw new IllegalArgumentException("Invalid constructor trace package");
                scopes.add(prefix+".");
            }
        }
        if(flag==scopes.isEmpty())throw new IllegalArgumentException("Choose explicit constructor trace packages when enabling the trace");
        prefixes=List.copyOf(scopes);
        enabled=flag;
        if(!enabled){retained.clear();members.clear();sequence=0;dropped=0;droppedMembers=0;}
    }
    static boolean enabled(){return enabled;}

    private static final class Frame {
        final Frame parent;
        final Object factory, descriptor;
        final Map<String,Object> context, site;
        final List<AutowireHierarchy.Level> levels;
        final Map<String,AutowireHierarchy.Located> observedDefinitions=new LinkedHashMap<>();
        final List<Map<String,Object>> shadowed=new ArrayList<>();
        final int depth;
        final boolean member,optional,aggregate;
        Object nestedDescriptor;
        List<String> aggregateNames;
        String selected, suggested;
        boolean multiple, conflictingHint, reportedNonUnique, noCandidates, observedLookup;
        Frame(Frame parent,Object factory,Object descriptor,Map<String,Object> context,Map<String,Object> site,
                boolean member,boolean optional,boolean aggregate){
            this.parent=parent;this.factory=factory;this.descriptor=descriptor;this.context=context;this.site=site;
            this.member=member;this.optional=optional;this.aggregate=aggregate;
            levels=AutowireHierarchy.observe(factory);
            depth=parent==null?1:parent.depth+1;
        }
        boolean matches(Object factory,Object descriptor){
            return this.factory==factory&&(this.descriptor==descriptor||nestedDescriptor!=null&&nestedDescriptor==descriptor);
        }
        void recordDefinition(String name)throws ReflectiveOperationException{
            if(observedDefinitions.containsKey(name))return;
            var located=AutowireHierarchy.locate(levels,0,name);
            if(located!=null)observedDefinitions.put(name,located);
        }
    }

    private static String label(Object value){
        return value instanceof String text&&text.matches("[A-Za-z0-9_.$:@ -]{1,180}")&&!text.isBlank()?text:null;
    }
    private static String type(Class<?> value){
        String name=value.getName();
        return !value.isArray()&&name.length()<=256&&name.matches("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*")?name:null;
    }
    private static String memberType(Class<?> value){
        if(value.isArray()&&value.getComponentType().isArray())return null;
        String name=type(value.isArray()?value.getComponentType():value);
        return name==null?null:name+(value.isArray()?"[]":"");
    }
    private static boolean inScope(String name){return name!=null&&prefixes.stream().anyMatch(name::startsWith);}
    private static Object metadata(Object value,String declaring,String name)throws ReflectiveOperationException{
        if(value==null)return null;
        Method method=value.getClass().getMethod(name);
        return method.getDeclaringClass().getName().equals(declaring)?method.invoke(value):null;
    }

    public static Object start(Object factory,Object descriptor,String requestingBean){
        try{
            if(!enabled||factory==null||descriptor==null||!factory.getClass().getName().equals(FACTORY)||
                !descriptor.getClass().getName().equals(DESCRIPTOR))return null;
            String consumer=label(requestingBean);
            if(consumer==null)return null;
            Object parameter=metadata(descriptor,"org.springframework.beans.factory.InjectionPoint","getMethodParameter");
            Object executable=metadata(parameter,"org.springframework.core.MethodParameter","getExecutable");
            if(!(executable instanceof Constructor<?> constructor)||constructor.isSynthetic()||constructor.getParameterCount()>PARAMETER_LIMIT)return null;
            String owner=type(constructor.getDeclaringClass());
            if(!inScope(owner))return null;
            Object rawIndex=metadata(parameter,"org.springframework.core.MethodParameter","getParameterIndex");
            if(!(rawIndex instanceof Integer index)||index<0||index>=constructor.getParameterCount())return null;
            Class<?>[] parameterTypes=constructor.getParameterTypes();
            Class<?> target=parameterTypes[index];
            if(target.isPrimitive()||target.isArray()||Collection.class.isAssignableFrom(target)||Map.class.isAssignableFrom(target)||
                target.getName().startsWith("java.util.")||target.getName().startsWith("org.springframework.beans.factory.Object")||
                target.getName().equals("jakarta.inject.Provider"))return null;
            List<String> signature=new ArrayList<>();
            for(Class<?> type:parameterTypes){String name=type(type);if(name==null)return null;signature.add(name);}
            Map<String,Object> site=new LinkedHashMap<>();
            site.put("owner",owner);site.put("parameterTypes",List.copyOf(signature));site.put("parameterIndex",index);
            site.put("requestingBean",consumer);
            var javaParameter=constructor.getParameters()[index];
            if(javaParameter.isNamePresent()&&label(javaParameter.getName())!=null)site.put("parameterName",javaParameter.getName());
            return frame(factory,descriptor,site,false,false,false);
        }catch(Throwable ignored){return null;}
    }

    private static Frame frame(Object factory,Object descriptor,Map<String,Object> site,boolean member,boolean optional,boolean aggregate){
            Map<String,Object> context=PersistenceContextRuntime.beanFactoryIdentity(factory);
            if(context==null)return null;
            Frame previous=active.get();
            if(previous!=null&&previous.depth>=DEPTH_LIMIT)return null;
            Frame frame=new Frame(previous,factory,descriptor,context,Map.copyOf(site),member,optional,aggregate);
            active.set(frame);
            return frame;
    }

    private static boolean ordinaryMemberCaller(ClassLoader loader,boolean field){
        String caller="org.springframework.beans.factory.annotation.AutowiredAnnotationBeanPostProcessor$"+
            (field?"AutowiredFieldElement":"AutowiredMethodElement");
        String method=field?"resolveFieldValue":"resolveMethodArguments";
        return CALLERS.walk(stack->stack.skip(3).findFirst().filter(frame->frame.getClassName().equals(caller)&&
            frame.getMethodName().equals(method)&&frame.getDeclaringClass().getClassLoader()==loader).isPresent());
    }
    private static Class<?> elementType(Class<?> raw,Type generic){
        if(raw.isArray())return raw.getComponentType();
        if(raw!=Optional.class&&!AGGREGATES.contains(raw))return raw;
        if(!(generic instanceof ParameterizedType parameterized)||
            !generic.getClass().getName().equals("sun.reflect.generics.reflectiveObjects.ParameterizedTypeImpl"))return null;
        Type[] types=parameterized.getActualTypeArguments();
        int size=raw==Map.class?2:1;
        return types.length==size&&(size==1||types[0]==String.class)&&types[size-1] instanceof Class<?> type?type:null;
    }

    public static Object startMember(Object factory,Object descriptor,String requestingBean,Object names){
        try{
            if(!enabled||factory==null||descriptor==null||!factory.getClass().getName().equals(FACTORY)||
                !descriptor.getClass().getName().equals(MEMBER_DESCRIPTOR)||names==null||names.getClass()!=java.util.LinkedHashSet.class)return null;
            String consumer=label(requestingBean);
            if(consumer==null)return null;
            Map<String,Object> site=new LinkedHashMap<>();
            Class<?> raw;
            Type generic;
            Object springField=metadata(descriptor,"org.springframework.beans.factory.InjectionPoint","getField");
            if(springField instanceof Field field){
                String owner=type(field.getDeclaringClass()), name=label(field.getName());
                if(!inScope(owner)||name==null||field.isSynthetic()||Modifier.isStatic(field.getModifiers())||
                    !ordinaryMemberCaller(factory.getClass().getClassLoader(),true))return null;
                site.put("kind","field");site.put("owner",owner);site.put("member",name);
                raw=field.getType();generic=field.getGenericType();
            }else{
                Object parameter=metadata(descriptor,"org.springframework.beans.factory.InjectionPoint","getMethodParameter");
                if(!(metadata(parameter,"org.springframework.core.MethodParameter","getExecutable") instanceof Method method)||
                    method.isSynthetic()||method.isBridge()||Modifier.isStatic(method.getModifiers())||
                    method.getParameterCount()>PARAMETER_LIMIT)return null;
                String owner=type(method.getDeclaringClass()), name=label(method.getName());
                if(!inScope(owner)||name==null||!ordinaryMemberCaller(factory.getClass().getClassLoader(),false))return null;
                if(!(metadata(parameter,"org.springframework.core.MethodParameter","getParameterIndex") instanceof Integer index)||
                    index<0||index>=method.getParameterCount())return null;
                List<String> signature=new ArrayList<>();
                for(Class<?> item:method.getParameterTypes()){
                    String value=memberType(item);if(value==null)return null;
                    signature.add(value);
                }
                site.put("kind","method");site.put("owner",owner);site.put("member",name);
                site.put("parameterTypes",List.copyOf(signature));site.put("parameterIndex",index);
                var javaParameter=method.getParameters()[index];
                if(javaParameter.isNamePresent()&&label(javaParameter.getName())!=null)site.put("parameterName",javaParameter.getName());
                raw=method.getParameterTypes()[index];generic=method.getGenericParameterTypes()[index];
            }
            Class<?> element=elementType(raw,generic);
            String dependency=element==null?null:type(element), signature=memberType(raw);
            if(!inScope(dependency)||signature==null)return null;
            site.put("requestedType",signature);site.put("dependencyType",dependency);site.put("requestingBean",consumer);
            return frame(factory,descriptor,site,true,raw==Optional.class,raw.isArray()||AGGREGATES.contains(raw));
        }catch(Throwable ignored){return null;}
    }

    public static void optional(Object nested,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame!=null&&frame.member&&frame.optional&&frame.descriptor==descriptor&&frame.factory==factory&&nested!=null)
                frame.nestedDescriptor=nested;
        }catch(Throwable ignored){}
    }

    public static void emptyCandidates(boolean empty,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(empty&&frame!=null&&frame.member&&frame.matches(factory,descriptor))frame.noCandidates=true;
        }catch(Throwable ignored){}
    }

    public static void aggregated(Object names,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame==null||!frame.aggregate||!frame.matches(factory,descriptor))return;
            if(!(names instanceof Set<?> keys)||!names.getClass().getName().equals("java.util.LinkedHashMap$LinkedKeySet")||
                keys.isEmpty()||keys.size()>12||frame.aggregateNames!=null){frame.multiple=true;return;}
            List<String> observed=new ArrayList<>();
            for(Object key:keys){
                String bean=label(key);
                if(bean==null){frame.multiple=true;return;}
                observed.add(bean);
            }
            frame.aggregateNames=observed.stream().sorted().toList();
            for(String name:frame.aggregateNames)frame.recordDefinition(name);
        }catch(Throwable ignored){}
    }

    public static void selected(Object candidate,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame==null||!frame.matches(factory,descriptor))return;
            String name=label(candidate);
            if(name==null){frame.multiple=true;return;}
            if(frame.selected!=null&&!frame.selected.equals(name))frame.multiple=true;
            else{
                frame.selected=name;
                frame.recordDefinition(name);
            }
        }catch(Throwable ignored){}
    }
    public static void suggested(Object candidate,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame==null||!frame.matches(factory,descriptor))return;
            String name=label(candidate);
            if(name==null)return;
            if(frame.suggested!=null&&!frame.suggested.equals(name))frame.conflictingHint=true;
            else frame.suggested=name;
        }catch(Throwable ignored){}
    }

    public static void ambiguous(Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame!=null&&frame.matches(factory,descriptor))frame.reportedNonUnique=true;
        }catch(Throwable ignored){}
    }

    public static Object enterAncestorLookup(Object factory,Object descriptor){
        Frame previous=ancestorLookup.get();
        try{
            Frame frame=active.get();
            if(frame!=null&&frame.matches(factory,descriptor)&&!frame.aggregate&&frame.levels.size()>1){
                ancestorLookup.set(frame);
                frame.observedLookup=true;
            }else ancestorLookup.remove();
        }catch(Throwable ignored){}
        return previous;
    }

    public static void exitAncestorLookup(Object previous){
        if(previous instanceof Frame frame)ancestorLookup.set(frame);else ancestorLookup.remove();
    }

    public static void mergedAncestorNames(Object result,Object local,Object inherited,Object factory){
        try{
            Frame frame=ancestorLookup.get();
            if(frame==null||frame!=active.get()||!(result instanceof String[] merged)||
                !(local instanceof String[] owned)||!(inherited instanceof String[] ancestors)||
                merged.length>64||owned.length>64||ancestors.length>64)return;
            int level=-1;
            for(var entry:frame.levels)if(entry.factory()==factory){level=entry.distance();break;}
            if(level<0)return;
            List<String> localNames=java.util.Arrays.asList(owned), mergedNames=java.util.Arrays.asList(merged);
            for(String name:ancestors){
                if(label(name)==null||frame.shadowed.size()>=AutowireHierarchy.SHADOW_LIMIT)continue;
                boolean replaced=localNames.contains(name);
                if(!replaced&&mergedNames.contains(name))continue;
                var hidden=AutowireHierarchy.shadow(name,frame.levels,level,replaced?"replaced":"hidden");
                if(hidden!=null&&!frame.shadowed.contains(hidden))frame.shadowed.add(hidden);
            }
        }catch(Throwable ignored){}
    }

    public static void end(Object resolved,Object token,Object failure){
        try{
            if(!(token instanceof Frame frame)||active.get()!=frame)return;
            if(frame.parent==null)active.remove();else active.set(frame.parent);
            Map<String,Object> event=new LinkedHashMap<>();
            event.put("context",frame.context);event.put("site",frame.site);
            List<String> names=frame.aggregateNames!=null?frame.aggregateNames:
                frame.selected!=null?List.of(frame.selected):List.of();
            boolean levelProof=frame.levels.equals(AutowireHierarchy.observe(frame.factory));
            List<Map<String,Object>> origins=levelProof&&!names.isEmpty()?
                AutowireHierarchy.selected(frame.levels,names,frame.observedDefinitions,AutowireRuntime::inScope):null;
            if(!frame.conflictingHint&&frame.suggested!=null&&(!frame.member||frame.suggested.equals(frame.selected)))
                event.put("suggestedName",frame.suggested);
            if(frame.reportedNonUnique&&failure!=null&&failure.getClass().getName().equals(AMBIGUOUS)){
                event.put("state","ambiguous");
            }else if(failure==null&&frame.member&&frame.noCandidates&&frame.selected==null&&frame.aggregateNames==null&&
                (resolved==null||resolved instanceof Optional<?> optional&&optional.isEmpty())){
                event.put("state","missing");
            }else if(failure==null&&resolved!=null&&!frame.multiple&&frame.aggregateNames!=null&&frame.selected==null&&origins!=null){
                event.put("state","aggregated");
                event.put("selectedBeans",frame.aggregateNames);
            }else if(failure==null&&resolved!=null&&!frame.multiple&&frame.selected!=null&&frame.aggregateNames==null&&
                (!(resolved instanceof Optional<?> optional)||optional.isPresent())&&origins!=null){
                event.put("state","resolved");event.put("selectedBean",frame.selected);
            }else if(failure==null){
                event.put("state","unproved");
            }else return;
            if(levelProof&&frame.levels.size()>1){
                Map<String,Object> evidence=new LinkedHashMap<>();
                if(origins!=null&&("resolved".equals(event.get("state"))||"aggregated".equals(event.get("state"))))
                    evidence.put("owners",origins);
                if(!frame.shadowed.isEmpty())evidence.put("shadowed",List.copyOf(frame.shadowed));
                if(frame.observedLookup)evidence.put("byTypeLookupObserved",true);
                if(!frame.conflictingHint&&frame.suggested!=null)evidence.put("resolverHint",frame.suggested);
                if(!evidence.isEmpty())event.put("hierarchy",Map.copyOf(evidence));
            }
            synchronized(AutowireRuntime.class){
                event.put("id",++sequence);
                ArrayDeque<Map<String,Object>> queue=frame.member?members:retained;
                if(queue.size()>=LIMIT){
                    queue.removeFirst();
                    if(frame.member)droppedMembers++;else dropped++;
                }
                queue.addLast(Map.copyOf(event));
            }
        }catch(Throwable ignored){}
    }

    static synchronized Map<String,Object> snapshot(List<String> instruments){
        boolean observed=instruments.containsAll(List.of(AutowireTransformer.CONSTRUCTOR,AutowireTransformer.FACTORY));
        return Map.of("state",!enabled?"disabled":observed?"observed":"awaiting-hooks",
            "events",observed&&enabled?List.copyOf(retained):List.of(),"omitted",dropped,
            "inspectionInvokedBeans",false,"beanValuesRetained",false,"observerExecutedSql",false);
    }
    static synchronized Map<String,Object> memberSnapshot(List<String> instruments){
        boolean observed=instruments.contains(AutowireTransformer.MEMBERS);
        return Map.of("state",!enabled?"disabled":observed?"observed":"awaiting-hooks",
            "events",observed&&enabled?List.copyOf(members):List.of(),"omitted",droppedMembers,
            "inspectionInvokedBeans",false,"beanValuesRetained",false,"observerExecutedSql",false);
    }
}
