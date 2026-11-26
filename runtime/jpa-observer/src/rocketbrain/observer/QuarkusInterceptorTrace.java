package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.Instruction;
import java.lang.classfile.Label;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.ConstantInstruction;
import java.lang.classfile.instruction.FieldInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.invoke.MethodType;
import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Observes Arc's synchronous around-invoke plan and entries, without calling application code. */
public final class QuarkusInterceptorTrace {
    private static final String ARC="io/quarkus/arc/impl/";
    private static final String CONTEXT=ARC+"AroundInvokeInvocationContext", INVOCATION=ARC+"InterceptorInvocation";
    private static final String INTERCEPTOR="io/quarkus/arc/InjectableInterceptor";
    private static final String TYPE="Ljakarta/enterprise/inject/spi/InterceptionType;";
    private static final String JAKARTA_CONTEXT="Ljakarta/interceptor/InvocationContext;";
    private static final String ARC_CONTEXT="Lio/quarkus/arc/ArcInvocationContext;";
    private static final String OBJECT_TYPE="Ljava/lang/Object;";
    private static final String PERFORM="("+OBJECT_TYPE+"["+OBJECT_TYPE+"L"+ARC+"InterceptedMethodMetadata;)"+OBJECT_TYPE;
    private static final String INTERCEPT="("+TYPE+OBJECT_TYPE+JAKARTA_CONTEXT+")"+OBJECT_TYPE;
    private static final ClassDesc META=ClassDesc.ofInternalName(ARC+"InterceptedMethodMetadata");
    private static final ClassDesc METHOD=ClassDesc.of("java.lang.reflect.Method");
    private static final ClassDesc LIST=ClassDesc.of("java.util.List"), SET=ClassDesc.of("java.util.Set");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V"), BOOLEAN=ClassDesc.ofDescriptor("Z");
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.QuarkusInterceptorTrace");
    private static final Pattern NAME=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*){0,11}");
    private static final Pattern MEMBER=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]{0,95}");
    private static final Set<String> LISTS=Set.of("java.util.ArrayList","java.util.Arrays$ArrayList",
        "java.util.ImmutableCollections$List12","java.util.ImmutableCollections$ListN",
        "java.util.Collections$SingletonList","java.util.Collections$EmptyList","java.util.Collections$UnmodifiableRandomAccessList");
    private static final Set<String> SETS=Set.of("java.util.HashSet","java.util.LinkedHashSet","java.util.ImmutableCollections$Set12",
        "java.util.ImmutableCollections$SetN","java.util.Collections$SingletonSet","java.util.Collections$EmptySet");
    private static final int MAX_EVENTS=32, MAX_CHAIN=16, MAX_TARGETS=128, MAX_HANDLES=512;
    private static final ThreadLocal<Frame> active=new ThreadLocal<>();
    private static final List<Loader> loaders=new ArrayList<>();
    private static final List<Handle> handles=new ArrayList<>();
    private static final List<Map<String,Object>> events=new ArrayList<>();
    private static volatile Set<String> packages=Set.of();
    private static boolean contextsInstalled,invocationsInstalled,limited;
    private static long sequence;

    private record Target(String owner,String member,String descriptor) {
        Map<String,Object> report(){return Map.of("owner",owner,"member",member,"descriptor",descriptor);}
    }
    private record Interceptor(Target target,int priority) {}
    private record Handle(WeakReference<Object> invocation,Interceptor interceptor) {}
    private record Loader(WeakReference<ClassLoader> value,Map<String,Interceptor> generated) {}
    private record Token(Frame previous,Frame current) {}
    private static final class Frame {
        final Target target;
        final List<String> bindings;
        final List<Map<String,Object>> configured=new ArrayList<>();
        final List<Integer> entered=new ArrayList<>();
        final IdentityHashMap<Object,Integer> index=new IdentityHashMap<>();
        final int depth;
        Frame(Target target,List<String> bindings,int depth){this.target=target;this.bindings=bindings;this.depth=depth;}
    }

    private QuarkusInterceptorTrace(){}
    static boolean enabled(){return !packages.isEmpty();}
    static synchronized void configure(Object value){
        Set<String> approved=new LinkedHashSet<>();
        if(value!=null){
            if(!(value instanceof List<?> list)||list.size()>4)throw new IllegalArgumentException("Choose up to four Quarkus interceptor packages");
            for(Object item:list){
                if(!(item instanceof String name)||name.length()>160||!NAME.matcher(name).matches()||!approved.add(name))
                    throw new IllegalArgumentException("Invalid Quarkus interceptor package");
            }
        }
        packages=Set.copyOf(approved);contextsInstalled=false;invocationsInstalled=false;limited=false;
        sequence=0;loaders.clear();handles.clear();events.clear();active.remove();
    }
    private static boolean approved(String name){
        return name.length()<=160&&NAME.matcher(name).matches()&&packages.stream().anyMatch(prefix->name.startsWith(prefix+"."));
    }
    private static synchronized void limit(){limited=true;}
    private static synchronized void installed(boolean context){if(context)contextsInstalled=true;else invocationsInstalled=true;}

    private static synchronized void generated(ClassLoader loader,String name,Interceptor interceptor){
        loaders.removeIf(item->item.value().get()==null);
        Loader found=loaders.stream().filter(item->item.value().get()==loader).findFirst().orElse(null);
        if(found==null){
            if(loaders.size()>=6){limit();return;}
            found=new Loader(new WeakReference<>(loader),new LinkedHashMap<>());
            loaders.add(found);
        }
        if(found.generated().size()>=MAX_TARGETS&&!found.generated().containsKey(name)){limit();return;}
        found.generated().put(name,interceptor);
    }

    public static synchronized void registered(Object invocation,Object bean){
        try{
            if(!enabled()||bean==null||!approved(bean.getClass().getName()))return;
            Class<?> type=bean.getClass();
            Loader loader=loaders.stream().filter(item->item.value().get()==type.getClassLoader()).findFirst().orElse(null);
            Interceptor interceptor=loader==null?null:loader.generated().get(type.getName());
            if(interceptor==null)return;
            handles.removeIf(item->item.invocation().get()==null);
            if(handles.size()>=MAX_HANDLES){limit();return;}
            handles.add(new Handle(new WeakReference<>(invocation),interceptor));
        }catch(Throwable ignored){limit();}
    }

    private static Class<?> annotationInterface(Object literal){
        Set<Class<?>> pending=new LinkedHashSet<>();
        for(Class<?> current=literal.getClass();current!=null&&pending.size()<16;current=current.getSuperclass()){
            for(Class<?> iface:current.getInterfaces())if(iface.isAnnotation())pending.add(iface);
        }
        return pending.size()==1?pending.iterator().next():null;
    }
    private static List<String> bindingTypes(Object bindings){
        if(!(bindings instanceof Set<?> set)||!SETS.contains(set.getClass().getName())||set.size()>16){limit();return List.of();}
        Set<String> names=new LinkedHashSet<>();
        for(Object value:set){
            Class<?> annotation=value==null?null:annotationInterface(value);
            if(annotation==null||!approved(annotation.getName())){limit();continue;}
            names.add(annotation.getName());
        }
        return names.stream().sorted().toList();
    }

    private static synchronized Frame frame(Method method,Object bindings,Object chain,int depth){
        if(!(chain instanceof List<?> list)||!LISTS.contains(list.getClass().getName())||list.isEmpty()||list.size()>MAX_CHAIN){
            limit();return null;
        }
        String descriptor=MethodType.methodType(method.getReturnType(),method.getParameterTypes()).descriptorString();
        if(method.getParameterCount()>24||descriptor.length()>240||!MEMBER.matcher(method.getName()).matches()){limit();return null;}
        Frame frame=new Frame(new Target(method.getDeclaringClass().getName(),method.getName(),descriptor),bindingTypes(bindings),depth);
        for(int index=0;index<list.size();index++){
            Object invocation=list.get(index);
            if(invocation==null||!invocation.getClass().getName().equals(INVOCATION.replace('/','.'))||
                frame.index.put(invocation,index)!=null){limit();return null;}
            Interceptor known=handles.stream().filter(item->item.invocation().get()==invocation).findFirst().map(Handle::interceptor).orElse(null);
            if(known==null){limit();frame.configured.add(Map.of("kind","unresolved"));}
            else frame.configured.add(Map.of("kind","source","target",known.target().report(),"priority",known.priority()));
        }
        return frame;
    }

    public static Object begin(Method method,Object bindings,Object chain){
        Frame previous=active.get(),current=null;
        try{
            int depth=previous==null?1:previous.depth+1;
            if(enabled()&&method!=null&&approved(method.getDeclaringClass().getName())){
                if(depth<=8)current=frame(method,bindings,chain,depth);else limit();
            }
        }catch(Throwable ignored){limit();}
        if(current==null)active.remove();else active.set(current);
        return previous==null&&current==null?null:new Token(previous,current);
    }
    public static void entered(Object invocation){
        try{
            Frame frame=active.get();
            if(frame==null)return;
            Integer index=frame.index.get(invocation);
            if(index==null)return;
            if(frame.entered.size()>=32){limit();return;}
            frame.entered.add(index);
        }catch(Throwable ignored){limit();}
    }
    public static void end(Object value,boolean returned){
        if(!(value instanceof Token token))return;
        if(token.previous()==null)active.remove();else active.set(token.previous());
        if(token.current()==null)return;
        try{record(token.current(),returned);}catch(Throwable ignored){limit();}
    }
    private static synchronized void record(Frame frame,boolean returned){
        if(!enabled())return;
        if(events.size()==MAX_EVENTS){events.removeFirst();limited=true;}
        events.add(Map.of("id","arc-interception-"+(++sequence),"target",frame.target.report(),"bindingTypes",frame.bindings,
            "configured",List.copyOf(frame.configured),"entered",List.copyOf(frame.entered),"outcome",returned?"returned":"threw"));
    }
    static synchronized Map<String,Object> snapshot(){
        return Map.of("state",!enabled()?"disabled":!contextsInstalled||!invocationsInstalled?"waiting":limited?"partial":"ready",
            "processId",ProcessHandle.current().pid(),"packages",packages.stream().sorted().toList(),"invocations",List.copyOf(events),
            "bindingValuesRetained",false,"argumentsRetained",false,"inspectionInvokedApplication",false);
    }

    static final class Transformer implements ClassFileTransformer {
        private final Instrumentation instrumentation;
        Transformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}
        @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
            if(!enabled()||loader==null||name==null)return null;
            if(!CONTEXT.equals(name)&&!INVOCATION.equals(name)){
                String binary=name.replace('/','.');
                if(approved(binary)&&binary.endsWith("_Bean")){
                    try{
                        Interceptor target=interceptor(ClassFile.of().parse(bytes));
                        if(target!=null)generated(loader,binary,target);
                    }catch(RuntimeException ignored){limit();}
                }
                return null;
            }
            try{
                if(Class.forName(QuarkusInterceptorTrace.class.getName(),false,loader)!=QuarkusInterceptorTrace.class)
                    throw new IllegalStateException("Arc interceptor observer is not visible");
                if(module!=null&&module.isNamed()&&!module.canRead(QuarkusInterceptorTrace.class.getModule()))
                    instrumentation.redefineModule(module,Set.of(QuarkusInterceptorTrace.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
                ClassFile format=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
                boolean context=CONTEXT.equals(name);
                byte[] transformed=context?scope(format,format.parse(bytes)):hooks(format,format.parse(bytes));
                installed(context);
                return transformed;
            }catch(Throwable failure){
                ObserverRuntime.warning("Quarkus interceptor observation unavailable ("+failure.getClass().getSimpleName()+")");
                return null;
            }
        }
    }

    private static List<Instruction> instructions(MethodModel method){
        List<Instruction> items=new ArrayList<>();
        if(method.code().isPresent())for(CodeElement element:method.code().orElseThrow())
            if(element instanceof Instruction instruction)items.add(instruction);
        return items;
    }
    private static Object constant(ClassModel model,String name,String descriptor,Opcode exit){
        MethodModel found=model.methods().stream()
            .filter(method->method.methodName().equalsString(name)&&method.methodType().equalsString(descriptor)).findFirst().orElse(null);
        if(found==null)return null;
        List<Instruction> code=instructions(found);
        return code.size()==2&&code.getFirst() instanceof ConstantInstruction literal&&code.getLast().opcode()==exit?
            literal.constantValue():null;
    }
    private static Interceptor interceptor(ClassModel model){
        if(model.interfaces().stream().noneMatch(item->item.asInternalName().equals(INTERCEPTOR)))return null;
        if(!(constant(model,"getBeanClass","()Ljava/lang/Class;",Opcode.ARETURN) instanceof ClassDesc bean)||
            !(constant(model,"getPriority","()I",Opcode.IRETURN) instanceof Integer priority))return null;
        String internal=bean.descriptorString();
        if(!internal.startsWith("L")||!internal.endsWith(";"))return null;
        internal=internal.substring(1,internal.length()-1);
        String owner=internal.replace('/','.');
        if(!approved(owner))return null;
        Set<Target> calls=new LinkedHashSet<>();
        for(MethodModel method:model.methods()){
            if(!method.methodName().equalsString("intercept")||!method.methodType().equalsString(INTERCEPT))continue;
            for(Instruction instruction:instructions(method)){
                if(instruction instanceof InvokeInstruction call&&call.owner().asInternalName().equals(internal)&&
                    MEMBER.matcher(call.name().stringValue()).matches()&&
                    (call.type().equalsString("("+JAKARTA_CONTEXT+")"+OBJECT_TYPE)||call.type().equalsString("("+ARC_CONTEXT+")"+OBJECT_TYPE))){
                    calls.add(new Target(owner,call.name().stringValue(),call.type().stringValue()));
                }
            }
        }
        return calls.size()==1?new Interceptor(calls.iterator().next(),priority):null;
    }

    private static byte[] scope(ClassFile format,ClassModel model){
        int[] matches={0,0};
        byte[] result=format.transformClass(model,(builder,element)->{
            if(element instanceof MethodModel method&&method.methodName().equalsString("perform")&&method.methodType().equalsString(PERFORM)&&
                instructions(method).stream().anyMatch(instruction->instruction instanceof FieldInstruction field&&
                    field.owner().asInternalName().equals(ARC+"InterceptedMethodMetadata")&&field.name().equalsString("chain"))){
                matches[0]++;
                builder.transformMethod(method,MethodTransform.transformingCode(new InvocationScope(matches)));
            }else builder.with(element);
        });
        if(matches[0]!=1||matches[1]!=2)throw new IllegalStateException("Unsupported Arc around-invoke scope");
        return result;
    }
    private static final class InvocationScope implements CodeTransform {
        final int[] matches;
        Label start,end,failed;
        int token;
        InvocationScope(int[] matches){this.matches=matches;}
        @Override public void atStart(CodeBuilder code){
            token=code.allocateLocal(TypeKind.REFERENCE);
            start=code.newLabel();end=code.newLabel();failed=code.newLabel();
            Label skip=code.newLabel();
            code.aconst_null().astore(token).aload(2).ifnull(skip);
            code.aload(2).getfield(META,"method",METHOD).aload(2).getfield(META,"bindings",SET).aload(2).getfield(META,"chain",LIST)
                .invokestatic(HELPER,"begin",MethodTypeDesc.of(OBJECT,METHOD,OBJECT,OBJECT)).astore(token);
            code.labelBinding(skip).labelBinding(start);
        }
        @Override public void accept(CodeBuilder code,CodeElement element){
            if(element instanceof ReturnInstruction exit&&exit.typeKind()==TypeKind.REFERENCE){matches[1]++;finish(code,true);}
            code.with(element);
        }
        private void finish(CodeBuilder code,boolean returned){
            code.aload(token);
            if(returned)code.iconst_1();else code.iconst_0();
            code.invokestatic(HELPER,"end",MethodTypeDesc.of(VOID,OBJECT,BOOLEAN));
        }
        @Override public void atEnd(CodeBuilder code){
            code.labelBinding(end).labelBinding(failed);
            finish(code,false);
            code.athrow().exceptionCatchAll(start,end,failed);
        }
    }

    private static byte[] hooks(ClassFile format,ClassModel model){
        int[] matches={0,0};
        byte[] result=format.transformClass(model,(builder,element)->{
            if(element instanceof MethodModel method&&method.methodName().equalsString("<init>")&&
                method.methodType().equalsString("("+TYPE+"L"+INTERCEPTOR+";"+OBJECT_TYPE+")V")){
                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                    if(instruction instanceof ReturnInstruction exit&&exit.typeKind()==TypeKind.VOID){
                        matches[0]++;
                        code.aload(0).aload(2).invokestatic(HELPER,"registered",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                    }
                    code.with(instruction);
                }));
            }else if(element instanceof MethodModel method&&method.methodName().equalsString("invoke")&&
                method.methodType().equalsString("("+JAKARTA_CONTEXT+")"+OBJECT_TYPE)){
                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                    if(instruction instanceof InvokeInstruction call&&call.owner().asInternalName().equals(INTERCEPTOR)&&
                        call.name().equalsString("intercept")&&call.type().equalsString(INTERCEPT)){
                        matches[1]++;
                        code.aload(0).invokestatic(HELPER,"entered",MethodTypeDesc.of(VOID,OBJECT));
                    }
                    code.with(instruction);
                }));
            }else builder.with(element);
        });
        if(matches[0]!=1||matches[1]!=1)throw new IllegalStateException("Unsupported Arc interceptor dispatch");
        return result;
    }
}
