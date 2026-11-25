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
    private static final String AUTH="org/springframework/security/authorization/";
    private static final String METHOD=AUTH+"method/";
    private static final String AUTHORITIES=AUTH+"AuthoritiesAuthorizationManager";
    private static final String INVOCATION="Lorg/aopalliance/intercept/MethodInvocation;";
    private static final String AUTH_RESULT="L"+AUTH+"AuthorizationResult;";
    private static final String AUTH_CALL="(Ljava/util/function/Supplier;Ljava/lang/Object;)"+AUTH_RESULT;
    private static final String COLLECTION="Ljava/util/Collection;";
    private static final String AUTHENTICATION="Lorg/springframework/security/core/Authentication;";
    private static final String ROLE_HIERARCHY="org/springframework/security/access/hierarchicalroles/RoleHierarchy";
    private static final String HTTP_REQUEST="Ljakarta/servlet/http/HttpServletRequest;";
    private static final String REQUEST="Ljakarta/servlet/ServletRequest;", RESPONSE="Ljakarta/servlet/ServletResponse;";
    private static final String FILTER="("+REQUEST+RESPONSE+"Ljakarta/servlet/FilterChain;)V";
    private static final String CHAIN="("+REQUEST+RESPONSE+")V";
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.SecurityTraceRuntime"), OBJECT=ClassDesc.of("java.lang.Object");
    private static final ClassDesc METHOD_HELPER=ClassDesc.of("rocketbrain.observer.MethodSecurityTrace"), STRING=ClassDesc.of("java.lang.String");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V"), BOOLEAN=ClassDesc.ofDescriptor("Z"), THROWABLE=ClassDesc.of("java.lang.Throwable");

    private enum Hook {
        PROXY("proxy"), STANDARD("standard-execution"), OBSERVATION("observation-execution"), AUTHORIZATION("authorization"),
        BEFORE("method-before"), AFTER("method-after"), ROLES("method-roles"), MANAGER("method-manager");
        final String label;
        Hook(String label){this.label=label;}
    }
    private static final Map<String,Hook> CLASSES=Map.of(WEB+"FilterChainProxy",Hook.PROXY,
        WEB+"FilterChainProxy$VirtualFilterChain",Hook.STANDARD,WEB+"ObservationFilterChainDecorator$ObservationFilter",Hook.OBSERVATION,
        WEB+"access/intercept/AuthorizationFilter",Hook.AUTHORIZATION,METHOD+"AuthorizationManagerBeforeMethodInterceptor",Hook.BEFORE,
        METHOD+"AuthorizationManagerAfterMethodInterceptor",Hook.AFTER,AUTHORITIES,Hook.ROLES,
        AUTH+"ObservationAuthorizationManager",Hook.MANAGER);
    private final Instrumentation instrumentation;
    SecurityTraceTransformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}

    @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
        if(name==null || !CLASSES.containsKey(name))return null;
        Hook hook=CLASSES.get(name);
        if((hook==Hook.BEFORE||hook==Hook.AFTER||hook==Hook.ROLES||hook==Hook.MANAGER)&&!MethodSecurityTrace.enabled())return null;
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
            int expectedMethods=hook==Hook.PROXY||hook==Hook.ROLES?2:1;
            int expectedCalls=switch(hook){case BEFORE->3;case AFTER,ROLES->2;default->1;};
            if(methods[0]!=expectedMethods||calls[0]!=expectedCalls)throw new IllegalStateException("Unsupported Spring Security bytecode shape");
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
        if(hook==Hook.BEFORE||hook==Hook.AFTER){
            String suffix=hook==Hook.AFTER?"Ljava/lang/Object;":"";
            return name.equals("attemptAuthorization")&&descriptor.equals("("+INVOCATION+suffix+")Ljava/lang/Object;")
                ?new MethodScope(hook,calls):null;
        }
        if(hook==Hook.MANAGER)return name.equals("authorize")&&descriptor.equals(AUTH_CALL)?managerDelegate(calls):null;
        if(hook==Hook.ROLES){
            if(name.equals("getGrantedAuthorities")&&descriptor.equals("("+AUTHENTICATION+")"+COLLECTION))return roleSource(calls);
            if(name.equals("isAuthorized")&&descriptor.equals("("+AUTHENTICATION+COLLECTION+")Z"))return roleComparison(calls);
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
    private static CodeTransform managerDelegate(int[] calls){
        return (code,element)->{
            if(call(element,AUTH+"AuthorizationManager","authorize",AUTH_CALL)){
                calls[0]++;
                int input=code.allocateLocal(TypeKind.REFERENCE), supplier=code.allocateLocal(TypeKind.REFERENCE);
                int manager=code.allocateLocal(TypeKind.REFERENCE);
                code.astore(input).astore(supplier).astore(manager);
                code.aload(0).aload(manager).invokestatic(METHOD_HELPER,"managerDelegate",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                code.aload(manager).aload(supplier).aload(input);
            }
            code.with(element);
        };
    }

    private static CodeTransform roleSource(int[] calls){
        return (code,element)->{
            if(call(element,ROLE_HIERARCHY,"getReachableGrantedAuthorities","("+COLLECTION+")"+COLLECTION)){
                calls[0]++;
                code.dup2().pop().invokestatic(METHOD_HELPER,"roleSource",MethodTypeDesc.of(VOID,OBJECT));
            }
            code.with(element);
        };
    }

    private static CodeTransform roleComparison(int[] calls){
        return (code,element)->{
            if(call(element,"java/util/Collection","contains","(Ljava/lang/Object;)Z")){
                calls[0]++;
                int checked=code.allocateLocal(TypeKind.REFERENCE);
                code.dup().astore(checked).with(element);
                code.dup().aload(checked).invokestatic(METHOD_HELPER,"roleCompared",MethodTypeDesc.of(VOID,BOOLEAN,OBJECT));
                return;
            }
            code.with(element);
        };
    }

    private static final class MethodScope implements CodeTransform {
        private final Hook hook;
        private final int[] calls;
        private Label first,last,failed;
        private int token;

        MethodScope(Hook hook,int[] calls){this.hook=hook;this.calls=calls;}

        @Override public void atStart(CodeBuilder code){
            token=code.allocateLocal(TypeKind.REFERENCE);
            code.aconst_null().astore(token);
            first=code.newLabel();last=code.newLabel();failed=code.newLabel();code.labelBinding(first);
        }

        @Override public void accept(CodeBuilder code,CodeElement element){
            if(call(element,AUTH+"AuthorizationManager","authorize",AUTH_CALL)){
                calls[0]++;
                int input=code.allocateLocal(TypeKind.REFERENCE), supplier=code.allocateLocal(TypeKind.REFERENCE);
                int manager=code.allocateLocal(TypeKind.REFERENCE);
                code.astore(input).astore(supplier).astore(manager);
                code.ldc(hook==Hook.BEFORE?"before":"after").aload(1).aload(manager)
                    .invokestatic(METHOD_HELPER,"enter",MethodTypeDesc.of(OBJECT,STRING,OBJECT,OBJECT)).astore(token);
                code.aload(manager).aload(supplier).aload(input).with(element);
                code.dup().aload(token).invokestatic(METHOD_HELPER,"result",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                return;
            }
            if(call(element,AUTH+"AuthorizationResult","isGranted","()Z")){
                calls[0]++;
                code.with(element);
                code.dup().aload(token).invokestatic(METHOD_HELPER,"decision",MethodTypeDesc.of(VOID,BOOLEAN,OBJECT));
                return;
            }
            if(hook==Hook.BEFORE&&call(element,METHOD+"AuthorizationManagerBeforeMethodInterceptor","handle",
                "("+INVOCATION+"L"+AUTH+"AuthorizationDeniedException;)Ljava/lang/Object;")){
                calls[0]++;
                code.aload(token).invokestatic(METHOD_HELPER,"thrownDenial",MethodTypeDesc.of(VOID,OBJECT));
            }
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE)exit(code);
            code.with(element);
        }

        private void exit(CodeBuilder code){code.aload(token).invokestatic(METHOD_HELPER,"exit",MethodTypeDesc.of(VOID,OBJECT));}

        @Override public void atEnd(CodeBuilder code){
            code.labelBinding(last).labelBinding(failed);
            exit(code);
            code.athrow().exceptionCatchAll(first,last,failed);
        }
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
