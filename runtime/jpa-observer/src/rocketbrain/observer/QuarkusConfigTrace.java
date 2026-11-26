package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Observes exclusively metadata from an existing SmallRye configuration lookup. */
public final class QuarkusConfigTrace {
    private static final String CONFIG="io/smallrye/config/SmallRyeConfig", VALUE="io/smallrye/config/ConfigValue";
    private static final String PROFILES="io/smallrye/config/ProfileConfigSourceInterceptor";
    private static final String VALUE_SIGNATURE="(Ljava/lang/String;)L"+VALUE+";";
    private static final String CONFIG_TYPE=CONFIG.replace('/','.'), VALUE_TYPE=VALUE.replace('/','.');
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.QuarkusConfigTrace");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object"), STRING=ClassDesc.of("java.lang.String"),
        VOID=ClassDesc.ofDescriptor("V");
    private static final Pattern KEY=Pattern.compile("[A-Za-z][A-Za-z0-9._-]{0,159}");
    private static final Pattern PROFILE=Pattern.compile("[A-Za-z][A-Za-z0-9-]{0,45}");
    private static final Pattern FILE=Pattern.compile("PropertiesConfigSource\\[source=((?:jar:)?file:[^\\r\\n\\]]{1,3000})[/!]"+
        "(application(?:-[A-Za-z][A-Za-z0-9-]{0,45})?\\.properties)\\]");
    private static final Set<String> ORDINARY_LISTS=Set.of("java.util.ArrayList","java.util.Arrays$ArrayList",
        "java.util.ImmutableCollections$List12","java.util.ImmutableCollections$ListN",
        "java.util.Collections$EmptyList","java.util.Collections$SingletonList");
    private static final int MAX_CONTEXTS=8, MAX_KEYS=24;
    private static volatile Set<String> keys=Set.of();
    private static boolean instrumented, limited;
    private static long sequence;
    private static final List<Context> contexts=new ArrayList<>();
    private static final List<ProfileList> profileLists=new ArrayList<>();

    private record Origin(String kind,String file) {}
    private record ProfileList(WeakReference<Object> wrapper,List<String> names) {}
    private record Observation(String kind,String file,Integer ordinal,Integer line,String profile) {
        Map<String,Object> report(String key){
            Map<String,Object> row=new LinkedHashMap<>();
            row.put("key",key);row.put("kind",kind);row.put("file",file);row.put("ordinal",ordinal);
            row.put("line",line);row.put("selectedProfile",profile);
            return row;
        }
    }
    private static final class Context {
        final long id=++sequence;
        final WeakReference<Object> instance;
        final Map<String,Observation> origins=new LinkedHashMap<>();
        List<String> profiles;
        Context(Object instance,List<String> profiles){this.instance=new WeakReference<>(instance);this.profiles=profiles;}
        Map<String,Object> report(){
            return Map.of("id","config-"+id,"activeProfiles",profiles,
                "origins",origins.entrySet().stream().map(entry->entry.getValue().report(entry.getKey())).toList());
        }
    }
    private record Readers(Method name,Method source,Method ordinal,Method line,Method profile,Method profiles,Class<?> valueType) {}
    private static final ClassValue<Readers> readers=new ClassValue<>(){
        @Override protected Readers computeValue(Class<?> config){
            try{
                Class<?> value=config.getDeclaredMethod("getConfigValue",String.class).getReturnType();
                if(!value.getName().equals(VALUE_TYPE)||config.getClassLoader()!=value.getClassLoader())return null;
                return new Readers(value.getDeclaredMethod("getName"),value.getDeclaredMethod("getConfigSourceName"),
                    value.getDeclaredMethod("getConfigSourceOrdinal"),value.getDeclaredMethod("getLineNumber"),
                    value.getDeclaredMethod("getProfile"),config.getDeclaredMethod("getProfiles"),value);
            }catch(ReflectiveOperationException failure){return null;}
        }
    };

    private QuarkusConfigTrace(){}
    static boolean enabled(){return !keys.isEmpty();}
    static synchronized void configure(Object selected){
        if(selected==null)selected=List.of();
        if(!(selected instanceof List<?> list)||list.size()>MAX_KEYS)throw new IllegalArgumentException("Invalid Quarkus config keys");
        Set<String> chosen=new LinkedHashSet<>();
        for(Object entry:list)if(!(entry instanceof String key)||!KEY.matcher(key).matches()||!chosen.add(key))
            throw new IllegalArgumentException("Invalid or repeated Quarkus config key");
        keys=Set.copyOf(chosen);instrumented=false;limited=false;
        contexts.clear();profileLists.clear();
    }

    public static void observed(Object value,Object config,String key){
        if(key==null||!keys.contains(key)||value==null||config==null||!CONFIG_TYPE.equals(config.getClass().getName()))return;
        try{
            Readers access=readers.get(config.getClass());
            if(access==null||access.valueType()!=value.getClass()||!key.equals(access.name().invoke(value)))return;
            List<String> profiles=observedProfiles(access.profiles().invoke(config));
            if(profiles==null){limit();return;}
            String source=(String)access.source().invoke(value);
            String profile=(String)access.profile().invoke(value);
            Origin origin=origin(source);
            int ordinal=(int)access.ordinal().invoke(value), line=(int)access.line().invoke(value);
            Observation metadata=new Observation(origin.kind(),origin.file(),source==null?null:ordinal,
                origin.file()!=null&&line>0&&line<=100000?line:null,
                profile!=null&&PROFILE.matcher(profile).matches()?profile:null);
            retain(config,profiles,key,metadata);
        }catch(Throwable ignored){limit();}
    }
    private static List<String> profileNames(Object result){
        if(!(result instanceof List<?> values)||!ORDINARY_LISTS.contains(result.getClass().getName())||values.size()>16)
            return null;
        List<String> safe=new ArrayList<>();
        for(Object item:values){
            if(!(item instanceof String name)||!PROFILE.matcher(name).matches()||safe.contains(name))return null;
            safe.add(name);
        }
        return List.copyOf(safe);
    }
    public static synchronized void profileList(Object wrapper,Object copied){
        if(!enabled()||wrapper==null||copied==null||copied.getClass()!=ArrayList.class)return;
        try{
            List<String> profiles=profileNames(copied);
            if(profiles==null)return;
            profileLists.removeIf(row->row.wrapper().get()==null);
            if(profileLists.size()<32)profileLists.add(new ProfileList(new WeakReference<>(wrapper),profiles));
        }catch(Throwable ignored){}
    }
    private static synchronized List<String> observedProfiles(Object value){
        for(ProfileList row:profileLists)if(row.wrapper().get()==value)return row.names();
        return profileNames(value);
    }
    private static Origin origin(String source){
        if(source==null)return new Origin("unavailable",null);
        if("EnvConfigSource".equals(source))return new Origin("environment",null);
        if("SysPropConfigSource".equals(source))return new Origin("system",null);
        if("DefaultValuesConfigSource".equals(source))return new Origin("default",null);
        if(source.length()<=3072){
            var match=FILE.matcher(source);
            if(match.matches())return new Origin(match.group(1).startsWith("jar:")?"classpath-properties":"file-properties",match.group(2));
        }
        return new Origin("other",null);
    }
    private static synchronized void limit(){if(enabled())limited=true;}
    private static synchronized void retain(Object config,List<String> profiles,String key,Observation metadata){
        if(!keys.contains(key))return;
        contexts.removeIf(context->context.instance.get()==null);
        for(Context context:contexts)if(context.instance.get()==config){
            if(!profiles.equals(context.profiles)){context.profiles=profiles;context.origins.clear();}
            context.origins.put(key,metadata);
            return;
        }
        if(contexts.size()>=MAX_CONTEXTS){limited=true;return;}
        Context context=new Context(config,profiles);
        context.origins.put(key,metadata);
        contexts.add(context);
    }
    static synchronized Map<String,Object> snapshot(){
        contexts.removeIf(context->context.instance.get()==null);
        return Map.of("state",!enabled()?"disabled":!instrumented?"waiting":limited?"partial":"ready",
            "processId",ProcessHandle.current().pid(),"keys",keys.stream().sorted().toList(),
            "contexts",contexts.stream().map(Context::report).toList());
    }
    private static synchronized void installed(){if(enabled())instrumented=true;}

    static final class Transformer implements ClassFileTransformer {
        private final Instrumentation instrumentation;
        Transformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}
        @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
            if(!CONFIG.equals(name)&&!PROFILES.equals(name))return null;
            try{
                if(Class.forName(QuarkusConfigTrace.class.getName(),false,loader)!=QuarkusConfigTrace.class)
                    throw new IllegalStateException("Configuration origin observer is not visible");
                if(module!=null&&module.isNamed()&&!module.canRead(QuarkusConfigTrace.class.getModule()))
                    instrumentation.redefineModule(module,Set.of(QuarkusConfigTrace.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
                var classFile=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
                var model=classFile.parse(bytes);
                if(PROFILES.equals(name))return interceptProfiles(classFile,model);
                int[] matched={0,0,0};
                byte[] result=classFile.transformClass(model,(builder,element)->{
                    if(element instanceof MethodModel method&&method.methodName().equalsString("getConfigValue")&&
                        method.methodType().equalsString(VALUE_SIGNATURE)&&method.code().isPresent()){
                        matched[0]++;
                        builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                            if(instruction instanceof InvokeInstruction invocation&&invocation.owner().asInternalName()
                                .equals("io/smallrye/config/ConfigSourceInterceptorContext")&&invocation.name().equalsString("proceed")&&
                                invocation.type().equalsString(VALUE_SIGNATURE))matched[1]++;
                            if(instruction instanceof ReturnInstruction exit&&exit.typeKind()==TypeKind.REFERENCE){
                                matched[2]++;
                                code.dup().aload(0).aload(1).invokestatic(HELPER,"observed",MethodTypeDesc.of(VOID,OBJECT,OBJECT,STRING));
                            }
                            code.with(instruction);
                        }));
                    }else builder.with(element);
                });
                if(matched[0]!=1||matched[1]!=1||matched[2]!=1)
                    throw new IllegalStateException("Unsupported SmallRye configuration resolution shape");
                installed();return result;
            }catch(Throwable failure){
                ObserverRuntime.warning("SmallRye configuration origin observation unavailable ("+failure.getClass().getSimpleName()+")");
                return null;
            }
        }

        private static byte[] interceptProfiles(ClassFile format,java.lang.classfile.ClassModel model){
            int[] matched={0};
            byte[] result=format.transformClass(model,(builder,element)->{
                if(element instanceof MethodModel method&&method.methodName().equalsString("<init>")&&
                    method.methodType().equalsString("(Ljava/util/List;)V")&&method.code().isPresent()){
                    builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                        if(instruction instanceof InvokeInstruction invocation&&invocation.owner().asInternalName().equals("java/util/Collections")&&
                            invocation.name().equalsString("unmodifiableList")&&invocation.type().equalsString("(Ljava/util/List;)Ljava/util/List;")){
                            matched[0]++;
                            int copied=code.allocateLocal(TypeKind.REFERENCE);
                            code.dup().astore(copied).with(instruction).dup().aload(copied)
                                .invokestatic(HELPER,"profileList",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                        }else code.with(instruction);
                    }));
                }else builder.with(element);
            });
            if(matched[0]!=1)throw new IllegalStateException("Unsupported SmallRye profile container shape");
            return result;
        }
    }
}
