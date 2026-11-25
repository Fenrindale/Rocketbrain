package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.Label;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.Map;
import java.util.Set;

/** Probes exact servlet dispatch sites and leaves both call arguments and exceptions intact. */
final class SecurityTraceTransformer implements ClassFileTransformer {
    private static final String WEB="org/springframework/security/web/";
    private static final String HTTP_REQUEST="Ljakarta/servlet/http/HttpServletRequest;";
    private static final String REQUEST="Ljakarta/servlet/ServletRequest;", RESPONSE="Ljakarta/servlet/ServletResponse;";
    private static final String FILTER="("+REQUEST+RESPONSE+"Ljakarta/servlet/FilterChain;)V";
    private static final String CHAIN="("+REQUEST+RESPONSE+")V";
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.SecurityTraceRuntime"), OBJECT=ClassDesc.of("java.lang.Object");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V"), BOOLEAN=ClassDesc.ofDescriptor("Z"), THROWABLE=ClassDesc.of("java.lang.Throwable");

    private enum Hook {
        PROXY("proxy"), STANDARD("standard-execution"), OBSERVATION("observation-execution"), AUTHORIZATION("authorization");
        final String label;
        Hook(String label){this.label=label;}
    }
    private static final Map<String,Hook> CLASSES=Map.of(WEB+"FilterChainProxy",Hook.PROXY,
        WEB+"FilterChainProxy$VirtualFilterChain",Hook.STANDARD,WEB+"ObservationFilterChainDecorator$ObservationFilter",Hook.OBSERVATION,
        WEB+"access/intercept/AuthorizationFilter",Hook.AUTHORIZATION);
    private final Instrumentation instrumentation;
    SecurityTraceTransformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}

    @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
        if(name==null || !CLASSES.containsKey(name))return null;
        Hook hook=CLASSES.get(name);
        try{
            if(Class.forName(SecurityTraceRuntime.class.getName(),false,loader)!=SecurityTraceRuntime.class)
                throw new IllegalStateException("Trace helper is not visible");
            if(module!=null&&module.isNamed()&&!module.canRead(SecurityTraceRuntime.class.getModule()))
                instrumentation.redefineModule(module,Set.of(SecurityTraceRuntime.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
            int[] methods={0}, calls={0};
            ClassFile format=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            byte[] transformed=format.transformClass(format.parse(bytes),(builder,element)->{
                if(element instanceof MethodModel method){
                    CodeTransform action=probe(hook,method,calls);
                    if(action!=null){methods[0]++;builder.transformMethod(method,MethodTransform.transformingCode(action));return;}
                }
                builder.with(element);
            });
            int expectedMethods=hook==Hook.PROXY?2:1;
            if(methods[0]!=expectedMethods||calls[0]!=1)throw new IllegalStateException("Unsupported Spring Security bytecode shape");
            SecurityTraceRuntime.instrumented(hook.label);
            return transformed;
        }catch(Throwable failure){ObserverRuntime.warning("Spring Security trace unavailable for "+hook.label+" ("+failure.getClass().getSimpleName()+")");return null;}
    }

    private static CodeTransform probe(Hook hook,MethodModel method,int[] calls){
        String name=method.methodName().stringValue(), descriptor=method.methodType().stringValue();
        if(hook==Hook.PROXY){
            if(name.equals("doFilter")&&descriptor.equals(FILTER))return new RequestScope();
            if(name.equals("getFilters")&&descriptor.equals("("+HTTP_REQUEST+")Ljava/util/List;"))return selection(calls);
            return null;
        }
        String methodName=hook==Hook.OBSERVATION?"wrapFilter":"doFilter";
        if(!name.equals(methodName)||!descriptor.equals(hook==Hook.STANDARD?CHAIN:FILTER))return null;
        return hook==Hook.AUTHORIZATION?authorization(calls):execution(calls);
    }

    private static CodeTransform selection(int[] calls){
        return (code,instruction)->{
            if(call(instruction,WEB+"SecurityFilterChain","matches","("+HTTP_REQUEST+")Z")){
                calls[0]++;
                code.dup2().pop().invokestatic(HELPER,"candidate",MethodTypeDesc.of(VOID,OBJECT));
                code.with(instruction);
                code.dup().invokestatic(HELPER,"matched",MethodTypeDesc.of(VOID,BOOLEAN));
                return;
            }
            if(instruction instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE)
                code.dup().invokestatic(HELPER,"selected",MethodTypeDesc.of(VOID,OBJECT));
            code.with(instruction);
        };
    }
    private static CodeTransform authorization(int[] calls){
        return (code,instruction)->{
            code.with(instruction);
            if(call(instruction,"org/springframework/security/authorization/AuthorizationResult","isGranted","()Z")){
                calls[0]++;
                code.dup().invokestatic(HELPER,"decision",MethodTypeDesc.of(VOID,BOOLEAN));
            }
        };
    }
    private static CodeTransform execution(int[] calls){
        return (code,instruction)->{
            if(call(instruction,"jakarta/servlet/Filter","doFilter",FILTER)){
                calls[0]++;
                int chain=code.allocateLocal(TypeKind.REFERENCE), response=code.allocateLocal(TypeKind.REFERENCE);
                int request=code.allocateLocal(TypeKind.REFERENCE), filter=code.allocateLocal(TypeKind.REFERENCE);
                code.astore(chain).astore(response).astore(request).astore(filter);
                code.aload(filter).invokestatic(HELPER,"entered",MethodTypeDesc.of(VOID,OBJECT));
                code.aload(filter).aload(request).aload(response).aload(chain);
            }
            code.with(instruction);
        };
    }
    private static boolean call(CodeElement element,String owner,String name,String descriptor){
        return element instanceof InvokeInstruction call && call.owner().asInternalName().equals(owner) &&
            call.name().equalsString(name) && call.type().equalsString(descriptor);
    }
    private static final class RequestScope implements CodeTransform {
        private Label first,last,failed;
        @Override public void atStart(CodeBuilder code){
            code.aload(1).invokestatic(HELPER,"start",MethodTypeDesc.of(VOID,OBJECT));
            first=code.newLabel();last=code.newLabel();failed=code.newLabel();code.labelBinding(first);
        }
        @Override public void accept(CodeBuilder code,CodeElement element){
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.VOID)
                code.aload(1).aload(2).iconst_1().invokestatic(HELPER,"end",MethodTypeDesc.of(VOID,OBJECT,OBJECT,BOOLEAN));
            code.with(element);
        }
        @Override public void atEnd(CodeBuilder code){
            code.labelBinding(last).labelBinding(failed).aload(1).aload(2).iconst_0()
                .invokestatic(HELPER,"end",MethodTypeDesc.of(VOID,OBJECT,OBJECT,BOOLEAN)).athrow().exceptionCatchAll(first,last,failed);
        }
    }
}
