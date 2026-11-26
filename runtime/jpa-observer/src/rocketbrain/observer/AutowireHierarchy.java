package rocketbrain.observer;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

final class AutowireHierarchy {
    private static final String FACTORY="org.springframework.beans.factory.support.DefaultListableBeanFactory";
    private static final String SUPPORT="org.springframework.beans.factory.support.";
    private static final String ANNOTATED="org.springframework.beans.factory.annotation.";
    private static final String CONFIGURATION="org.springframework.context.annotation.ConfigurationClassBeanDefinitionReader$ConfigurationClassBeanDefinition";
    private static final Set<String> CLASSES=Set.of(SUPPORT+"GenericBeanDefinition", SUPPORT+"RootBeanDefinition",
        ANNOTATED+"AnnotatedGenericBeanDefinition", "org.springframework.context.annotation.ScannedGenericBeanDefinition");
    static final int LIMIT=8, SHADOW_LIMIT=12;
    private static final int SOURCE_PARAMETER_CHARS=1024;

    record Level(Object factory, Map<String,Object> context, int distance) {}
    record Located(Level level, Object definition) {}

    private AutowireHierarchy() {}

    static List<Level> observe(Object requesting) {
        try {
            var result = new ArrayList<Level>();
            Object current = requesting;
            while (current != null && exactFactory(current) && result.size() < LIMIT) {
                Object candidate = current;
                if (result.stream().anyMatch(level -> level.factory == candidate)) break;
                Map<String,Object> identity = PersistenceContextRuntime.beanFactoryIdentity(current);
                if (identity == null) break;
                result.add(new Level(current,identity,result.size()));
                current = current.getClass().getMethod("getParentBeanFactory").invoke(current);
            }
            return List.copyOf(result);
        } catch (Throwable ignored) { return List.of(); }
    }

    private static boolean exactFactory(Object value) {
        return value.getClass().getName().equals(FACTORY);
    }

    static Located locate(List<Level> levels, int first, String name) throws ReflectiveOperationException {
        // The captured name must remain canonical at every checked level. An alias or
        // unmanaged local singleton can hide a definition above it.
        for (int index=first; index<levels.size(); index++) {
            Level level=levels.get(index);
            Object factory=level.factory;
            Class<?> type=factory.getClass();
            if (!name.equals(type.getMethod("canonicalName",String.class).invoke(factory,name))) return null;
            if (Boolean.TRUE.equals(type.getDeclaredMethod("containsBeanDefinition",String.class).invoke(factory,name))) {
                Object definition=type.getDeclaredMethod("getBeanDefinition",String.class).invoke(factory,name);
                return new Located(level,definition);
            }
            if (Boolean.TRUE.equals(type.getMethod("containsSingleton",String.class).invoke(factory,name))) return null;
        }
        return null;
    }

    static List<Map<String,Object>> selected(List<Level> levels, List<String> names,
          Map<String,Located> before, Predicate<String> withinScope) throws ReflectiveOperationException {
        var result=new ArrayList<Map<String,Object>>();
        for(String name:names) {
            Located found=locate(levels,0,name);
            Located expected=before.get(name);
            if(found==null||expected==null||expected.level.factory!=found.level.factory||expected.definition!=found.definition)return null;
            var row=identity(name,found.level);
            Map<String,Object> source=source(found.definition);
            if(source!=null&&withinScope.test((String)source.get("owner")))row.put("source",source);
            result.add(Map.copyOf(row));
        }
        return List.copyOf(result);
    }

    static Map<String,Object> shadow(String name, List<Level> levels, int depth, String mode) throws ReflectiveOperationException {
        if(depth<0 || depth+1>=levels.size())return null;
        Located replaced=locate(levels,depth+1,name), blocker=locate(levels.subList(0,depth+1),depth,name);
        if(replaced==null||blocker==null)return null;
        var row=identity(name,replaced.level);
        row.put("hiddenBy",blocker.level.context);
        row.put("hiddenByDistance",blocker.level.distance);
        row.put("mode",mode);
        return Map.copyOf(row);
    }

    private static LinkedHashMap<String,Object> identity(String name, Level level) {
        var row=new LinkedHashMap<String,Object>();
        row.put("beanName",name);
        row.put("distance",level.distance);
        row.put("context",level.context);
        return row;
    }

    private static Map<String,Object> source(Object definition) {
        if(definition==null)return null;
        try {
            Class<?> type=definition.getClass();
            if(type.getName().equals(CONFIGURATION)) {
                Class<?> contract=Class.forName(ANNOTATED+"AnnotatedBeanDefinition",false,type.getClassLoader());
                Object metadata=contract.getMethod("getFactoryMethodMetadata").invoke(definition);
                if(metadata==null||!metadata.getClass().getName().equals("org.springframework.core.type.StandardMethodMetadata"))return null;
                Object raw=metadata.getClass().getMethod("getIntrospectedMethod").invoke(metadata);
                if(!(raw instanceof Method method)||method.isSynthetic()||method.isBridge()||method.getParameterCount()>24)return null;
                String owner=safeType(method.getDeclaringClass().getName()), returns=memberType(method.getReturnType());
                if(owner==null||returns==null||!method.getName().matches("[A-Za-z_$][A-Za-z0-9_$]{0,179}"))return null;
                List<String> parameters=Arrays.stream(method.getParameterTypes()).map(AutowireHierarchy::memberType).toList();
                if(parameters.contains(null)||parameters.stream().mapToInt(String::length).sum()>SOURCE_PARAMETER_CHARS)return null;
                return Map.of("kind","bean-method","owner",owner,"member",method.getName(),
                    "returnType",returns,"parameterTypes",parameters);
            }
            if(!CLASSES.contains(type.getName())||type.getMethod("getFactoryMethodName").invoke(definition)!=null)return null;
            Object raw=type.getMethod("getBeanClassName").invoke(definition);
            String owner=raw instanceof String name?safeType(name):null;
            return owner==null?null:Map.of("kind","class","owner",owner);
        } catch(Throwable ignored) {return null;}
    }

    private static String safeType(String name) {
        return name.length()<=256&&name.matches("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*")?name:null;
    }

    private static String memberType(Class<?> type) {
        if(type.isArray()) {
            Class<?> element=type.getComponentType();
            String name=safeType(element.getName());
            return name==null?null:name+"[]";
        }
        return safeType(type.getName());
    }
}
