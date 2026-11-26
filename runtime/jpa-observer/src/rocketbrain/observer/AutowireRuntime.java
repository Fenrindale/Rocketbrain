package rocketbrain.observer;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class AutowireRuntime {
    private static final int LIMIT=48, PARAMETER_LIMIT=24, DEPTH_LIMIT=8;
    private static final String FACTORY="org.springframework.beans.factory.support.DefaultListableBeanFactory";
    private static final String DESCRIPTOR="org.springframework.beans.factory.support.ConstructorResolver$ConstructorDependencyDescriptor";
    private static final String AMBIGUOUS="org.springframework.beans.factory.NoUniqueBeanDefinitionException";
    private static final ThreadLocal<Frame> active=new ThreadLocal<>();
    private static final ArrayDeque<Map<String,Object>> retained=new ArrayDeque<>();
    private static volatile List<String> prefixes=List.of();
    private static volatile boolean enabled;
    private static long sequence, dropped;

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
        if(!enabled){retained.clear();sequence=0;dropped=0;}
    }
    static boolean enabled(){return enabled;}

    private static final class Frame {
        final Frame parent;
        final Object factory, descriptor;
        final Map<String,Object> context, site;
        final int depth;
        String selected, suggested;
        boolean multiple, conflictingHint, reportedNonUnique;
        Frame(Frame parent,Object factory,Object descriptor,Map<String,Object> context,Map<String,Object> site){
            this.parent=parent;this.factory=factory;this.descriptor=descriptor;this.context=context;this.site=site;
            depth=parent==null?1:parent.depth+1;
        }
    }

    private static String label(Object value){
        return value instanceof String text&&text.matches("[A-Za-z0-9_.$:@ -]{1,180}")&&!text.isBlank()?text:null;
    }
    private static String type(Class<?> value){
        String name=value.getName();
        return !value.isArray()&&name.length()<=256&&name.matches("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*")?name:null;
    }
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
            if(owner==null||prefixes.stream().noneMatch(owner::startsWith))return null;
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
            Map<String,Object> context=PersistenceContextRuntime.beanFactoryIdentity(factory);
            if(context==null)return null;
            Frame previous=active.get();
            if(previous!=null&&previous.depth>=DEPTH_LIMIT)return null;
            Frame frame=new Frame(previous,factory,descriptor,context,Map.copyOf(site));
            active.set(frame);
            return frame;
        }catch(Throwable ignored){return null;}
    }

    public static void selected(Object candidate,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame==null||frame.factory!=factory||frame.descriptor!=descriptor)return;
            String name=label(candidate);
            if(name==null){frame.multiple=true;return;}
            if(frame.selected!=null&&!frame.selected.equals(name))frame.multiple=true;
            else frame.selected=name;
        }catch(Throwable ignored){}
    }
    public static void suggested(Object candidate,Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame==null||frame.factory!=factory||frame.descriptor!=descriptor)return;
            String name=label(candidate);
            if(name==null)return;
            if(frame.suggested!=null&&!frame.suggested.equals(name))frame.conflictingHint=true;
            else frame.suggested=name;
        }catch(Throwable ignored){}
    }

    public static void ambiguous(Object factory,Object descriptor){
        try{
            Frame frame=active.get();
            if(frame!=null&&frame.factory==factory&&frame.descriptor==descriptor)frame.reportedNonUnique=true;
        }catch(Throwable ignored){}
    }

    public static void end(Object resolved,Object token,Object failure){
        try{
            if(!(token instanceof Frame frame)||active.get()!=frame)return;
            if(frame.parent==null)active.remove();else active.set(frame.parent);
            Map<String,Object> event=new LinkedHashMap<>();
            event.put("context",frame.context);event.put("site",frame.site);
            if(!frame.conflictingHint&&frame.suggested!=null)event.put("suggestedName",frame.suggested);
            if(frame.reportedNonUnique&&failure!=null&&failure.getClass().getName().equals(AMBIGUOUS)){
                event.put("state","ambiguous");
            }else if(failure==null&&resolved!=null&&!frame.multiple&&frame.selected!=null&&localDefinition(frame)){
                event.put("state","resolved");event.put("selectedBean",frame.selected);
            }else if(failure==null){
                event.put("state","unproved");
            }else return;
            synchronized(AutowireRuntime.class){
                event.put("id",++sequence);
                if(retained.size()>=LIMIT){retained.removeFirst();dropped++;}
                retained.addLast(Map.copyOf(event));
            }
        }catch(Throwable ignored){}
    }

    private static boolean localDefinition(Frame frame)throws ReflectiveOperationException{
        // The exact Spring class's own map lookup. Never ask for a candidate instance.
        Method exists=frame.factory.getClass().getDeclaredMethod("containsBeanDefinition",String.class);
        return Boolean.TRUE.equals(exists.invoke(frame.factory,frame.selected));
    }

    static synchronized Map<String,Object> snapshot(List<String> instruments){
        boolean observed=instruments.containsAll(List.of(AutowireTransformer.CONSTRUCTOR,AutowireTransformer.FACTORY));
        return Map.of("state",!enabled?"disabled":observed?"observed":"awaiting-hooks",
            "events",observed&&enabled?List.copyOf(retained):List.of(),"omitted",dropped,
            "inspectionInvokedBeans",false,"beanValuesRetained",false,"observerExecutedSql",false);
    }
}
