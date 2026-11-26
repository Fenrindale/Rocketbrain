package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.ClassModel;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.FieldInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.classfile.instruction.ThrowInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.ref.WeakReference;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Records Arc's existing programmatic lookup decision without invoking an Arc bean. */
public final class QuarkusArcTrace {
    private static final String INSTANCE="io/quarkus/arc/impl/InstanceImpl", BEAN="io/quarkus/arc/InjectableBean";
    private static final String UNSATISFIED="jakarta.enterprise.inject.UnsatisfiedResolutionException";
    private static final String AMBIGUOUS="jakarta.enterprise.inject.AmbiguousResolutionException";
    private static final String LOOKUP_SIGNATURE="()L"+BEAN+";", CREATE_PREFIX="(Ljakarta/enterprise/context/spi/CreationalContext;)";
    private static final ClassDesc INSTANCE_CLASS=ClassDesc.ofInternalName(INSTANCE);
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.QuarkusArcTrace");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object");
    private static final MethodTypeDesc RECORD=MethodTypeDesc.of(ClassDesc.ofDescriptor("V"),OBJECT,OBJECT,OBJECT,OBJECT);
    private static final ClassDesc TYPE=ClassDesc.of("java.lang.reflect.Type"), QUALIFIERS=ClassDesc.of("java.util.Set");
    private static final int MAX_CONTEXTS=6, MAX_TARGETS=128, MAX_IDENTITIES=128, MAX_EVENTS=32, MAX_SAMPLES=6;
    private static final Pattern PACKAGE=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*){0,9}");
    private static final Pattern MEMBER=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]{0,95}");
    private static final Pattern BINARY_CLASS=Pattern.compile("[A-Za-z_$][A-Za-z0-9_.$-]{0,235}");
    private static final String DESCRIPTOR_TYPE="\\[{0,8}(?:[ZBSCIJFD]|L[A-Za-z_$][A-Za-z0-9_$/]*;)";
    private static final Pattern FIELD_DESCRIPTOR=Pattern.compile(DESCRIPTOR_TYPE);
    private static final Pattern METHOD_DESCRIPTOR=Pattern.compile("\\((?:"+DESCRIPTOR_TYPE+"){0,12}\\)"+DESCRIPTOR_TYPE);
    private static final Set<String> LISTS=Set.of("java.util.ImmutableCollections$ListN","java.util.ImmutableCollections$List12");
    private static final Set<String> SETS=Set.of("java.util.HashSet","java.util.LinkedHashSet","java.util.ImmutableCollections$SetN",
        "java.util.ImmutableCollections$Set12","java.util.Collections$EmptySet","java.util.Collections$SingletonSet");
    private static final List<Scope> scopes=new ArrayList<>();
    private static final List<Map<String,Object>> events=new ArrayList<>();
    private static volatile Set<String> packages=Set.of();
    private static boolean installed,limited;
    private static long scopeSequence,beanSequence,eventSequence;

    private record Target(String kind,String owner,String member,String descriptor) {
        Map<String,Object> report(){return Map.of("kind",kind,"owner",owner,"member",member,"descriptor",descriptor);}
    }
    private record Identity(WeakReference<Object> bean,String id) {}
    private static final class Scope {
        final String id="arc-loader-"+(++scopeSequence);
        final WeakReference<ClassLoader> loader;
        final Map<String,Target> producers=new LinkedHashMap<>();
        final List<Identity> identities=new ArrayList<>();
        Scope(ClassLoader value){loader=new WeakReference<>(value);}
        String identify(Object bean){
            identities.removeIf(identity->identity.bean().get()==null);
            for(Identity identity:identities)if(identity.bean().get()==bean)return identity.id();
            if(identities.size()>=MAX_IDENTITIES){limited=true;return null;}
            String id="arc-bean-"+(++beanSequence);
            identities.add(new Identity(new WeakReference<>(bean),id));
            return id;
        }
    }

    private QuarkusArcTrace(){}
    static boolean enabled(){return !packages.isEmpty();}
    static synchronized void configure(Object value){
        if(value==null)value=List.of();
        if(!(value instanceof List<?> list)||list.size()>4)throw new IllegalArgumentException("Invalid Quarkus Arc packages");
        Set<String> requested=new LinkedHashSet<>();
        for(Object item:list)if(!(item instanceof String name)||!validName(name)||!requested.add(name))
            throw new IllegalArgumentException("Invalid or repeated Quarkus Arc package");
        packages=Set.copyOf(requested);scopes.clear();events.clear();
        installed=false;limited=false;
    }
    private static boolean validName(String value){return value.length()<=160&&PACKAGE.matcher(value).matches();}
    private static boolean approvedPackage(String qualified){return packages.stream().anyMatch(p->qualified.startsWith(p+"."));}
    private static boolean approved(String qualified){return validName(qualified)&&approvedPackage(qualified);}
    private static boolean approvedClass(String binary){return BINARY_CLASS.matcher(binary).matches()&&approvedPackage(binary);}
    private static Scope findScope(ClassLoader loader){
        scopes.removeIf(scope->scope.loader.get()==null);
        for(Scope scope:scopes)if(scope.loader.get()==loader)return scope;
        if(scopes.size()>=MAX_CONTEXTS){limited=true;return null;}
        Scope scope=new Scope(loader);scopes.add(scope);return scope;
    }
    private static synchronized void index(ClassLoader loader,String name,Target target){
        Scope scope=findScope(loader);
        if(scope==null)return;
        if(scope.producers.size()<MAX_TARGETS)scope.producers.put(name,target);
        else limited=true;
    }
    private static synchronized void installed(){installed=true;}
    private static synchronized void limit(){if(enabled())limited=true;}

    private static boolean qualifierInterfaces(Class<?> type,Set<String> names,Set<Class<?>> visited){
        if(type==null||type==Object.class||visited.contains(type))return true;
        if(visited.size()>=24)return false;
        visited.add(type);
        Class<?>[] interfaces=type.getInterfaces();
        if(interfaces.length>24)return false;
        for(Class<?> item:interfaces){
            if(item.isAnnotation()){
                if(!validName(item.getName()))return false;
                names.add(item.getName());
            }else if(!qualifierInterfaces(item,names,visited))return false;
            if(names.size()>1)return false;
        }
        return qualifierInterfaces(type.getSuperclass(),names,visited);
    }
    private static List<String> qualifierTypes(Object source){
        if(!(source instanceof Set<?> values)||!SETS.contains(source.getClass().getName())||values.size()>8)return null;
        Set<String> result=new LinkedHashSet<>();
        for(Object value:values){
            Set<String> names=new LinkedHashSet<>();
            if(value==null||!qualifierInterfaces(value.getClass(),names,new LinkedHashSet<>())||names.size()!=1)return null;
            result.addAll(names);
        }
        return result.stream().sorted().toList();
    }

    public static void observed(Object outcome,Object candidates,Object requiredType,Object qualifiers){
        if(!enabled()||!(requiredType instanceof Class<?> type)||!approved(type.getName()))return;
        try{
            if(!(candidates instanceof List<?> eligible)||!LISTS.contains(candidates.getClass().getName())){limit();return;}
            int count=eligible.size();
            if(outcome==null){limit();return;}
            String outcomeType=outcome.getClass().getName();
            String status=null;
            if(count==1&&outcome==eligible.getFirst())status="selected";
            else if(count==0&&UNSATISFIED.equals(outcomeType))status="unsatisfied";
            else if(count>1&&AMBIGUOUS.equals(outcomeType))status="ambiguous";
            if(status==null){limit();return;}
            ClassLoader loader=type.getClassLoader();
            if(loader==null){limit();return;}
            retain(loader,type.getName(),qualifierTypes(qualifiers),status,eligible);
        }catch(Throwable ignored){limit();}
    }
    private static synchronized void retain(ClassLoader loader,String type,List<String> qualifiers,String status,List<?> eligible){
        if(!approved(type))return;
        Scope scope=findScope(loader);
        if(scope==null)return;
        List<Map<String,Object>> candidates=new ArrayList<>();
        for(int index=0;index<Math.min(MAX_SAMPLES,eligible.size());index++){
            Object bean=eligible.get(index);
            Class<?> actual=bean.getClass();
            boolean inScope=actual.getClassLoader()==loader&&approvedClass(actual.getName());
            Target target=inScope?scope.producers.get(actual.getName()):null;
            Map<String,Object> candidate=new LinkedHashMap<>();
            candidate.put("id",scope.identify(bean));
            candidate.put("kind",target!=null?target.kind():inScope?"opaque":"external");
            candidate.put("target",target==null?null:target.report());
            candidates.add(candidate);
        }
        Map<String,Object> event=new LinkedHashMap<>();
        event.put("id","arc-lookup-"+(++eventSequence));
        event.put("scope",scope.id);event.put("requiredType",type);
        event.put("qualifierTypes",qualifiers);event.put("status",status);
        event.put("eligibleCount",eligible.size());event.put("candidates",candidates);
        if(events.size()==MAX_EVENTS){events.removeFirst();limited=true;}
        events.add(event);
        if(qualifiers==null||eligible.size()>MAX_SAMPLES)limited=true;
    }
    static synchronized Map<String,Object> snapshot(){
        return Map.of("state",!enabled()?"disabled":!installed?"waiting":limited?"partial":"ready",
            "processId",ProcessHandle.current().pid(),"packages",packages.stream().sorted().toList(),"lookups",List.copyOf(events),
            "inspectionResolvedBeans",false,"qualifierValuesRetained",false,"beanValuesRetained",false);
    }

    static final class Transformer implements ClassFileTransformer {
        private final Instrumentation instrumentation;
        Transformer(Instrumentation value){instrumentation=value;}
        @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
            if(loader==null||name==null||!enabled())return null;
            if(!INSTANCE.equals(name)){
                String binary=name.replace('/','.');
                if(approvedClass(binary)&&binary.endsWith("_Bean")&&
                    (binary.contains("_ProducerMethod_")||binary.contains("_ProducerField_"))){
                    try{
                        Target target=producer(ClassFile.of().parse(bytes),name);
                        if(target!=null)index(loader,binary,target);
                    }catch(RuntimeException ignored){limit();}
                }
                return null;
            }
            try{
                if(Class.forName(QuarkusArcTrace.class.getName(),false,loader)!=QuarkusArcTrace.class)
                    throw new IllegalStateException("Arc observer is not visible");
                if(module!=null&&module.isNamed()&&!module.canRead(QuarkusArcTrace.class.getModule()))
                    instrumentation.redefineModule(module,Set.of(QuarkusArcTrace.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
                ClassFile format=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
                byte[] result=transformInstance(format,format.parse(bytes));
                installed();
                return result;
            }catch(Throwable failure){
                ObserverRuntime.warning("Quarkus Arc lookup observation unavailable ("+failure.getClass().getSimpleName()+")");
                return null;
            }
        }

        private static byte[] transformInstance(ClassFile format,ClassModel model){
            int[] matched={0,0,0,0};
            byte[] result=format.transformClass(model,(builder,element)->{
                if(element instanceof MethodModel method&&method.methodName().equalsString("bean")&&
                    method.methodType().equalsString(LOOKUP_SIGNATURE)&&method.code().isPresent()){
                    matched[0]++;
                    int[] slot={-1};
                    builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                        if(instruction instanceof InvokeInstruction call&&call.owner().asInternalName().equals(INSTANCE)&&
                            call.name().equalsString("beans")&&call.type().equalsString("()Ljava/util/List;")){
                            matched[1]++;
                            slot[0]=code.allocateLocal(TypeKind.REFERENCE);
                            code.with(instruction).dup().astore(slot[0]);
                            return;
                        }
                        boolean returning=instruction instanceof ReturnInstruction exit&&exit.typeKind()==TypeKind.REFERENCE;
                        boolean throwing=instruction instanceof ThrowInstruction;
                        if(returning||throwing){
                            if(slot[0]<0)throw new IllegalStateException("Unexpected Arc decision before candidate observation");
                            matched[returning?2:3]++;
                            code.dup().aload(slot[0]).aload(0).getfield(INSTANCE_CLASS,"requiredType",TYPE)
                                .aload(0).getfield(INSTANCE_CLASS,"requiredQualifiers",QUALIFIERS)
                                .invokestatic(HELPER,"observed",RECORD);
                        }
                        code.with(instruction);
                    }));
                }else builder.with(element);
            });
            if(matched[0]!=1||matched[1]!=1||matched[2]!=1||matched[3]!=2)
                throw new IllegalStateException("Unsupported Arc decision shape");
            return result;
        }

        private static Target producer(ClassModel model,String generated){
            if(!model.thisClass().asInternalName().equals(generated)||
                model.interfaces().stream().noneMatch(item->item.asInternalName().equals(BEAN)))return null;
            List<Target> targets=new ArrayList<>();
            for(MethodModel method:model.methods()){
                if(!method.methodName().equalsString("create")||method.code().isEmpty()||
                    !method.methodType().stringValue().startsWith(CREATE_PREFIX)||
                    method.methodType().stringValue().equals(CREATE_PREFIX+"Ljava/lang/Object;"))continue;
                for(var element:method.code().orElseThrow()){
                    if(element instanceof InvokeInstruction call&&
                        (call.opcode()==Opcode.INVOKEVIRTUAL||call.opcode()==Opcode.INVOKESTATIC)){
                        Target target=target(generated,call.owner().asInternalName(),call.name().stringValue(),call.type().stringValue(),"method");
                        if(target!=null)targets.add(target);
                    }else if(element instanceof FieldInstruction field&&
                        (field.opcode()==Opcode.GETFIELD||field.opcode()==Opcode.GETSTATIC)){
                        Target target=target(generated,field.owner().asInternalName(),field.name().stringValue(),field.type().stringValue(),"field");
                        if(target!=null)targets.add(target);
                    }
                }
            }
            return targets.size()==1?targets.getFirst():null;
        }
        private static Target target(String generated,String owner,String member,String descriptor,String kind){
            String binary=owner.replace('/','.');
            String marker=kind.equals("method")?"_ProducerMethod_":"_ProducerField_";
            if(!approved(binary)||!MEMBER.matcher(member).matches()||descriptor.length()>240||
                !(kind.equals("method")?METHOD_DESCRIPTOR:FIELD_DESCRIPTOR).matcher(descriptor).matches()||
                !generated.startsWith(owner+marker+member+"_"))return null;
            return new Target(kind,binary,member,descriptor);
        }
    }
}
