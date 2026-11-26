package rocketbrain.observer;

import java.lang.reflect.Constructor;
import java.lang.reflect.Executable;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class AutowireProviderTrace {
    private static final int LIMIT=48, DEPTH_LIMIT=8, PARAMETER_LIMIT=24;
    private static final String FACTORY=AutowireTransformer.FACTORY.replace('/','.');
    private static final String PROVIDER=FACTORY+"$DependencyObjectProvider";
    private static final String JAKARTA=FACTORY+"$Jsr330Factory$Jsr330Provider";
    private static final String NESTED=FACTORY+"$NestedDependencyDescriptor";
    private static final String OBJECT_PROVIDER="org.springframework.beans.factory.ObjectProvider";
    private static final String JAKARTA_PROVIDER="jakarta.inject.Provider";
    private static final String INJECTION="org.springframework.beans.factory.InjectionPoint";
    private static final String PARAMETER="org.springframework.core.MethodParameter";
    private static final String NO_BEAN="org.springframework.beans.factory.NoSuchBeanDefinitionException";
    private static final String NO_UNIQUE="org.springframework.beans.factory.NoUniqueBeanDefinitionException";
    private static final StackWalker CALLERS=StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE);
    private static final ThreadLocal<Frame> active=new ThreadLocal<>();
    private static final ArrayDeque<Map<String,Object>> events=new ArrayDeque<>();
    private static long sequence, dropped;

    private AutowireProviderTrace() {}

    private static final class Frame {
        final Frame parent;
        final int depth;
        final Object factory, descriptor;
        final Map<String,Object> site, context;
        final List<AutowireHierarchy.Level> levels;
        final String operation;
        String beforeName, selection;
        AutowireHierarchy.Located definition;
        boolean conflicting, empty, ambiguous;
        Frame(Frame parent,Object factory,Object descriptor,String operation,Map<String,Object> context,
                Map<String,Object> site,List<AutowireHierarchy.Level> levels){
            this.parent=parent;this.factory=factory;this.descriptor=descriptor;this.operation=operation;
            this.context=context;this.site=site;this.levels=levels;
            depth=parent==null?1:parent.depth+1;
        }
    }

    private static boolean frame(StackWalker.StackFrame at,ClassLoader loader,String owner,String method) {
        return at.getDeclaringClass().getClassLoader()==loader&&at.getClassName().equals(owner)&&at.getMethodName().equals(method);
    }

    private static String entry(Object factory,Object descriptor) {
        ClassLoader loader=factory.getClass().getClassLoader();
        Class<?> shape=descriptor.getClass();
        if(shape.getClassLoader()!=loader||(!shape.getName().equals(NESTED)&&
            !shape.getName().startsWith(PROVIDER+"$")))return null;
        return CALLERS.walk(stream->{
            var stack=stream.skip(2).limit(5).toList();
            if(stack.size()<3||!frame(stack.get(0),loader,FACTORY,"doResolveDependency"))return null;
            if(shape.isAnonymousClass()&&shape.getEnclosingClass()!=null&&shape.getEnclosingClass().getName().equals(PROVIDER)&&
                frame(stack.get(1),loader,PROVIDER,"getIfAvailable")&&AutowireRuntime.inScope(stack.get(2).getClassName())){
                return "getIfAvailable";
            }
            if(stack.size()!=5||!shape.getName().equals(NESTED)||!frame(stack.get(1),loader,PROVIDER,"resolveValue")||
                !frame(stack.get(2),loader,PROVIDER,"getValue")||!AutowireRuntime.inScope(stack.get(4).getClassName()))return null;
            if(frame(stack.get(3),loader,PROVIDER,"getObject"))return "getObject";
            return frame(stack.get(3),loader,JAKARTA,"get")?"get":null;
        });
    }

    private static Map<String,Object> site(Object descriptor,String consumer,String operation)throws ReflectiveOperationException{
        Map<String,Object> site=new LinkedHashMap<>();
        Class<?> raw, owner;
        Type generic;
        Object source=AutowireRuntime.metadata(descriptor,INJECTION,"getField");
        if(source instanceof Field field){
            if(field.isSynthetic()||Modifier.isStatic(field.getModifiers()))return null;
            raw=field.getType();generic=field.getGenericType();owner=field.getDeclaringClass();
            site.put("kind","field");site.put("member",field.getName());
        }else{
            Object parameter=AutowireRuntime.metadata(descriptor,INJECTION,"getMethodParameter");
            if(!(AutowireRuntime.metadata(parameter,PARAMETER,"getExecutable") instanceof Executable method)||
                method.isSynthetic()||method instanceof Method m&&m.isBridge()||Modifier.isStatic(method.getModifiers())||
                method.getParameterCount()>PARAMETER_LIMIT)return null;
            Object item=AutowireRuntime.metadata(parameter,PARAMETER,"getParameterIndex");
            if(!(item instanceof Integer index)||index<0||index>=method.getParameterCount())return null;
            var signature=new ArrayList<String>();
            for(Class<?> parameterType:method.getParameterTypes()){
                String type=AutowireRuntime.memberType(parameterType);
                if(type==null)return null;
                signature.add(type);
            }
            owner=method.getDeclaringClass();
            site.put("kind",method instanceof Constructor<?>?"constructor":"method");
            if(method instanceof Method m)site.put("member",m.getName());
            site.put("parameterIndex",index);site.put("parameterTypes",List.copyOf(signature));
            var named=method.getParameters()[index];
            if(named.isNamePresent()&&AutowireRuntime.label(named.getName())!=null)site.put("parameterName",named.getName());
            raw=method.getParameterTypes()[index];generic=method.getGenericParameterTypes()[index];
        }
        String declared=AutowireRuntime.type(owner), wrapper=raw.getName();
        if(!AutowireRuntime.inScope(declared)||
            !(operation.equals("get")?wrapper.equals(JAKARTA_PROVIDER):wrapper.equals(OBJECT_PROVIDER))||
            !(generic instanceof ParameterizedType parameterized)||
            !generic.getClass().getName().equals("sun.reflect.generics.reflectiveObjects.ParameterizedTypeImpl")||
            parameterized.getActualTypeArguments().length!=1||
            !(parameterized.getActualTypeArguments()[0] instanceof Class<?> dependency))return null;
        String target=AutowireRuntime.type(dependency);
        if(!AutowireRuntime.inScope(target))return null;
        site.put("owner",declared);site.put("requestedType",wrapper);site.put("dependencyType",target);
        site.put("requestingBean",consumer);
        return Map.copyOf(site);
    }

    public static Object start(Object factory,Object descriptor,String requestingBean){
        try{
            if(!AutowireRuntime.enabled()||factory==null||descriptor==null||!factory.getClass().getName().equals(FACTORY))return null;
            String bean=AutowireRuntime.label(requestingBean);
            if(bean==null)return null;
            String operation=entry(factory,descriptor);
            if(operation==null)return null;
            Map<String,Object> site=site(descriptor,bean,operation);
            if(site==null)return null;
            Frame previous=active.get();
            if(previous!=null&&previous.depth>=DEPTH_LIMIT)return null;
            var levels=AutowireHierarchy.observe(factory);
            if(levels.isEmpty())return null;
            Frame frame=new Frame(previous,factory,descriptor,operation,levels.getFirst().context(),site,levels);
            active.set(frame);
            return frame;
        }catch(Throwable ignored){return null;}
    }

    private static Frame matching(Object factory,Object descriptor){
        Frame frame=active.get();
        return frame!=null&&frame.factory==factory&&frame.descriptor==descriptor?frame:null;
    }

    public static void beforeLookup(Object name,Object factory,Object descriptor){
        try{
            Frame frame=matching(factory,descriptor);
            String label=AutowireRuntime.label(name);
            if(frame==null||label==null)return;
            if(frame.beforeName!=null&&!frame.beforeName.equals(label)){frame.conflicting=true;return;}
            frame.beforeName=label;
            frame.definition=AutowireHierarchy.locate(frame.levels,0,label);
        }catch(Throwable ignored){}
    }

    public static void selected(Object name,Object factory,Object descriptor){
        try{
            Frame frame=matching(factory,descriptor);
            String label=AutowireRuntime.label(name);
            if(frame==null||label==null||!label.equals(frame.beforeName))return;
            if(frame.selection!=null&&!frame.selection.equals(label)){frame.conflicting=true;return;}
            frame.selection=label;
        }catch(Throwable ignored){}
    }

    public static void empty(boolean empty,Object factory,Object descriptor){
        try{Frame frame=matching(factory,descriptor);if(frame!=null&&empty)frame.empty=true;}
        catch(Throwable ignored){}
    }

    public static void ambiguous(Object factory,Object descriptor){
        try{Frame frame=matching(factory,descriptor);if(frame!=null)frame.ambiguous=true;}
        catch(Throwable ignored){}
    }

    public static void end(Object result,Object token,Object failure){
        try{
            if(!(token instanceof Frame frame)||active.get()!=frame)return;
            if(frame.parent==null)active.remove();else active.set(frame.parent);
            if(!AutowireRuntime.enabled())return;
            Map<String,Object> event=new LinkedHashMap<>();
            event.put("context",frame.context);event.put("site",frame.site);event.put("operation",frame.operation);
            if(frame.ambiguous&&failure!=null&&failure.getClass().getName().equals(NO_UNIQUE)){
                event.put("state","ambiguous");
            }else if(frame.empty&&frame.selection==null&&result==null&&
                (failure==null||failure.getClass().getName().equals(NO_BEAN))){
                event.put("state","missing");
            }else if(failure==null&&result!=null&&frame.selection!=null&&frame.definition!=null&&!frame.conflicting&&
                frame.levels.equals(AutowireHierarchy.observe(frame.factory))){
                var located=AutowireHierarchy.selected(frame.levels,List.of(frame.selection),
                    Map.of(frame.selection,frame.definition),AutowireRuntime::inScope);
                if(located==null)return;
                event.put("state","resolved");event.put("selectedBean",frame.selection);
                event.put("hierarchy",Map.of("owners",located));
            }else return;
            synchronized(AutowireProviderTrace.class){
                if(!AutowireRuntime.enabled())return;
                event.put("id",++sequence);
                if(events.size()==LIMIT){events.removeFirst();dropped++;}
                events.addLast(Map.copyOf(event));
            }
        }catch(Throwable ignored){}
    }

    static synchronized void reset(){events.clear();sequence=0;dropped=0;}

    static synchronized Map<String,Object> snapshot(List<String> instruments) {
        boolean enabled=AutowireRuntime.enabled(), observed=instruments.contains(AutowireTransformer.PROVIDERS);
        return Map.of("state",!enabled?"disabled":observed?"observed":"awaiting-hooks",
            "events",enabled&&observed?List.copyOf(events):List.of(),"omitted",dropped,
            "inspectionInvokedBeans",false,"beanValuesRetained",false,"observerExecutedSql",false);
    }
}
