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
import java.lang.classfile.instruction.ExceptionCatch;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.LabelTarget;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.ref.WeakReference;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Records only the calls Spring actually makes in a supported servlet ProviderManager invocation. */
public final class AuthenticationProviderTrace {
    static final String HOOK="authentication-provider-manager";
    private static final String CORE="org/springframework/security/core/";
    private static final String AUTH="org/springframework/security/authentication/";
    private static final String MANAGER=AUTH+"ProviderManager";
    private static final String MANAGER_TYPE=MANAGER.replace('/','.');
    private static final String REJECTION_TYPE=CORE.replace('/','.')+"AuthenticationException";
    private static final String SERVICE_ERROR=AUTH.replace('/','.')+"InternalAuthenticationServiceException";
    private static final String NOT_FOUND=AUTH+"ProviderNotFoundException";
    private static final String AUTHENTICATION="L"+CORE+"Authentication;";
    private static final String AUTHENTICATE="("+AUTHENTICATION+")"+AUTHENTICATION;
    private static final int MAX_MANAGERS=6, MAX_PROVIDERS=12, MAX_IDENTITIES=64;
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.AuthenticationProviderTrace");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object"), VOID=ClassDesc.ofDescriptor("V"),
        BOOLEAN=ClassDesc.ofDescriptor("Z"), THROWABLE=ClassDesc.of("java.lang.Throwable");
    private static final List<ManagerIdentity> identities=new ArrayList<>();
    private static long managerSequence;
    private static volatile boolean enabled;

    private record ManagerIdentity(WeakReference<Object> owner,String id) {}
    private static final class Attempt {
        final String providerType;
        String stage="checking", outcome="unobserved";
        WeakReference<Throwable> failure;
        Attempt(String providerType){this.providerType=providerType;}
        Map<String,Object> report(int index){return Map.of("index",index,"providerType",providerType,"outcome",outcome);}
    }
    private static final class Frame {
        final AuthenticationProviderTrace trace;
        final String managerId, managerType;
        final int index;
        final List<Attempt> attempts=new ArrayList<>();
        Attempt pending;
        ParentCall parent;
        String outcome="unobserved", parentType;
        Integer selectedProvider, failureProvider;
        boolean incomplete, delegated, extraProviders;
        Frame(AuthenticationProviderTrace trace,String managerId,String managerType,int index){
            this.trace=trace;this.managerId=managerId;this.managerType=managerType;this.index=index;
        }
        boolean complete(){
            return !incomplete&&pending==null&&!outcome.equals("unobserved")&&(!delegated||parent!=null&&parent.complete());
        }
        Map<String,Object> report(){
            List<Map<String,Object>> ordered=new ArrayList<>();
            for(int at=0;at<attempts.size();at++)ordered.add(attempts.get(at).report(at+1));
            Map<String,Object> result=new LinkedHashMap<>();
            result.put("index",index);result.put("managerId",managerId);result.put("managerType",managerType);
            result.put("outcome",outcome);result.put("selectedProvider",selectedProvider);result.put("parentType",parentType);
            result.put("delegated",delegated);result.put("complete",complete());
            if(parent!=null)result.put("parentCall",parent.report());
            if(failureProvider!=null)result.put("failureProvider",failureProvider);
            result.put("providers",ordered);
            return result;
        }
    }

    private static final class ParentCall {
        final String managerId;
        Object expected;
        Frame child;
        String outcome="unobserved", disposition="unobserved";
        // Kept only while this stack frame is active, for reference equality with the actual outward decision.
        WeakReference<Object> boundaryValue;
        ParentCall(String managerId,Object expected){this.managerId=managerId;this.expected=expected;}
        private void observed(String state,Object value){
            expected=null;outcome=state;
            if(value!=null)boundaryValue=new WeakReference<>(value);
        }
        void finish(Object outward,boolean failure){
            if(outcome.equals("unobserved")&&failure)observed(authenticationException((Throwable)outward)?"rejected":"error",outward);
            if(!outcome.equals("unobserved")){
                boolean propagated=outward!=null&&boundaryValue!=null&&boundaryValue.get()==outward;
                disposition=propagated?"propagated":outcome.equals("provider-not-found")?"ignored-not-found":"unused";
            }
            boundaryValue=null;expected=null;
        }
        boolean complete(){
            if(child==null||!child.complete()||outcome.equals("unobserved")||disposition.equals("unobserved"))return false;
            return (outcome.equals("provider-not-found")?"rejected":outcome).equals(child.outcome);
        }
        Map<String,Object> report(){
            Map<String,Object> row=new LinkedHashMap<>();
            row.put("managerId",managerId);row.put("childIndex",child==null?null:child.index);
            row.put("outcome",outcome);row.put("disposition",disposition);
            return row;
        }
    }
    private final List<Frame> managers=new ArrayList<>();
    private ParentCall pendingParent;
    private boolean limited;

    static synchronized void configure(boolean option){enabled=option;identities.clear();managerSequence=0;}
    static boolean enabled(){return enabled;}
    private static synchronized String identity(Object owner){
        identities.removeIf(entry->entry.owner().get()==null);
        for(ManagerIdentity entry:identities)if(entry.owner().get()==owner)return entry.id();
        if(identities.size()>=MAX_IDENTITIES)return null;
        String id="manager-"+ ++managerSequence;
        identities.add(new ManagerIdentity(new WeakReference<>(owner),id));
        return id;
    }
    private static String type(Object owner){
        if(owner==null)return null;
        String name=owner.getClass().getName();
        return name.length()<=192&&name.matches("[A-Za-z0-9_.$]+")?name:null;
    }
    List<Map<String,Object>> reports(){
        return managers.stream().map(Frame::report).toList();
    }
    String coverage(boolean instrumented,boolean partial){
        if(!instrumented)return "unavailable";
        if(partial||limited||pendingParent!=null||managers.stream().anyMatch(frame->!frame.complete()))return "partial";
        return managers.isEmpty()?"unobserved":"observed";
    }

    public static Object enter(Object manager){
        AuthenticationProviderTrace trace=SecurityTraceRuntime.authenticationTrace();
        if(trace==null)return null;
        try{
            if(trace.managers.size()>=MAX_MANAGERS){trace.limited=true;return null;}
            String id=identity(manager), name=type(manager);
            if(id==null||name==null){trace.limited=true;return null;}
            Frame frame=new Frame(trace,id,name,trace.managers.size()+1);
            ParentCall edge=trace.pendingParent;
            if(edge!=null&&edge.expected==manager){
                edge.child=frame;edge.expected=null;trace.pendingParent=null;
            }
            trace.managers.add(frame);
            return frame;
        }catch(Throwable ignored){trace.limited=true;return null;}
    }
    private static Frame live(Object token){
        return token instanceof Frame frame&&SecurityTraceRuntime.authenticationTrace()==frame.trace?frame:null;
    }
    public static void checking(Object provider,Object token){
        Frame frame=live(token);if(frame==null)return;
        try{
            String name=type(provider);
            if(frame.pending!=null||name==null||frame.attempts.size()>=MAX_PROVIDERS){
                frame.incomplete=true;frame.extraProviders=true;frame.pending=null;return;
            }
            frame.pending=new Attempt(name);
            frame.attempts.add(frame.pending);
        }catch(Throwable ignored){frame.incomplete=true;}
    }
    public static void supports(boolean supported,Object token){
        Frame frame=live(token);if(frame==null||frame.extraProviders)return;
        if(frame.pending==null||!frame.pending.stage.equals("checking")){frame.incomplete=true;return;}
        if(supported)frame.pending.stage="supported";
        else seal(frame,"skipped");
    }
    public static void calling(Object provider,Object token){
        Frame frame=live(token);if(frame==null||frame.extraProviders)return;
        try{
            if(frame.pending==null||!frame.pending.stage.equals("supported")||!frame.pending.providerType.equals(type(provider))){
                frame.incomplete=true;return;
            }
            frame.pending.stage="authenticating";
        }catch(Throwable ignored){frame.incomplete=true;}
    }
    public static void result(boolean returned,Object token){
        Frame frame=live(token);if(frame==null||frame.extraProviders)return;
        if(frame.pending==null||!frame.pending.stage.equals("authenticating")){frame.incomplete=true;return;}
        seal(frame,returned?"returned":"abstained");
    }
    public static void delegated(Object parent,Object token,boolean observedBoundary){
        Frame frame=live(token);if(frame==null)return;
        try{
            frame.delegated=true;frame.parentType=type(parent);
            if(!observedBoundary)return;
            if(frame.parent!=null||parent==null||frame.trace.pendingParent!=null){frame.incomplete=true;return;}
            boolean exactParent=MANAGER_TYPE.equals(frame.parentType);
            frame.parent=new ParentCall(identity(parent),exactParent?parent:null);
            if(exactParent)frame.trace.pendingParent=frame.parent;
        }
        catch(Throwable ignored){frame.incomplete=true;}
    }

    private static void closePendingParent(Frame frame){
        if(frame.parent!=null&&frame.trace.pendingParent==frame.parent)frame.trace.pendingParent=null;
    }

    public static void parentReturned(Object result,Object token){
        Frame frame=live(token);if(frame==null||frame.parent==null)return;
        closePendingParent(frame);
        try{frame.parent.observed(result==null?"empty":"returned",result);}
        catch(Throwable ignored){frame.incomplete=true;}
    }

    public static void parentCaught(Throwable error,Object token,boolean ignoredNotFound){
        Frame frame=live(token);if(frame==null||frame.parent==null)return;
        closePendingParent(frame);
        try{
            frame.parent.observed(ignoredNotFound?"provider-not-found":authenticationException(error)?"rejected":"error",error);
        }catch(Throwable ignored){frame.incomplete=true;}
    }
    public static void caught(Throwable error,Object token){
        Frame frame=live(token);
        if(frame!=null&&frame.pending!=null&&frame.pending.stage.equals("authenticating")){
            try{frame.pending.failure=new WeakReference<>(error);}catch(Throwable ignored){}
            seal(frame,authenticationException(error)?"rejected":"error");
        }
    }
    public static void returned(Object result,Object token){
        Frame frame=live(token);if(frame==null)return;
        frame.outcome=result!=null?"returned":"unobserved";
        finishParent(frame,result,false);
        sealLocalFailure(frame,null);
        if(result==null||frame.incomplete||frame.pending!=null||frame.delegated)return;
        for(int at=0;at<frame.attempts.size();at++)if(frame.attempts.get(at).outcome.equals("returned")){
            if(frame.selectedProvider!=null){frame.incomplete=true;frame.selectedProvider=null;return;}
            frame.selectedProvider=at+1;
        }
        if(frame.selectedProvider==null)frame.incomplete=true;
    }
    public static void failed(Throwable error,Object token){
        Frame frame=live(token);if(frame==null)return;
        boolean rejected=authenticationException(error);
        frame.outcome=rejected?"rejected":"error";
        finishParent(frame,error,true);
        sealLocalFailure(frame,error);
        if(frame.pending!=null)seal(frame,frame.pending.stage.equals("authenticating")?
            (rejected?"rejected":"error"):frame.pending.stage.equals("checking")?"support-error":"unobserved");
    }
    private static void sealLocalFailure(Frame frame,Throwable outward){
        boolean parentPropagated=frame.parent!=null&&frame.parent.disposition.equals("propagated");
        int found=0;
        for(int at=0;at<frame.attempts.size();at++){
            Attempt attempt=frame.attempts.get(at);
            if(outward!=null&&!parentPropagated&&attempt.failure!=null&&attempt.failure.get()==outward)found=found==0?at+1:-1;
            attempt.failure=null;
        }
        if(found>0)frame.failureProvider=found;
    }
    private static void finishParent(Frame frame,Object outward,boolean failure){
        closePendingParent(frame);
        if(frame.parent!=null){
            try{frame.parent.finish(outward,failure);}
            catch(Throwable ignored){frame.incomplete=true;}
        }
    }
    private static void seal(Frame frame,String outcome){
        frame.pending.outcome=outcome;frame.pending=null;
        if(outcome.equals("unobserved"))frame.incomplete=true;
    }
    private static boolean authenticationException(Throwable error){
        try{
            if(error!=null)for(Class<?> parent=error.getClass();parent!=null;parent=parent.getSuperclass()){
                if(parent.getName().equals(SERVICE_ERROR))return false;
                if(parent.getName().equals(REJECTION_TYPE))return true;
            }
        }catch(Throwable ignored){}
        return false;
    }

    static final class Transformer implements ClassFileTransformer {
        private final Instrumentation instrumentation;
        Transformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}
        @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
            if(!MANAGER.equals(name))return null;
            try{
                if(Class.forName(AuthenticationProviderTrace.class.getName(),false,loader)!=AuthenticationProviderTrace.class)
                    throw new IllegalStateException("Authentication observer is not visible");
                if(module!=null&&module.isNamed()&&!module.canRead(AuthenticationProviderTrace.class.getModule()))
                    instrumentation.redefineModule(module,Set.of(AuthenticationProviderTrace.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
                ClassFile format=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
                var model=format.parse(bytes);
                var method=model.methods().stream().filter(item->item.methodName().equalsString("authenticate")&&
                    item.methodType().equalsString(AUTHENTICATE)).findFirst().orElseThrow();
                Map<String,Label> providerCatches=callHandlers(method,AUTH+"AuthenticationProvider");
                if(!providerCatches.keySet().equals(Set.of(AUTH+"AccountStatusException",AUTH+"InternalAuthenticationServiceException",CORE+"AuthenticationException")))
                    throw new IllegalStateException("Unsupported ProviderManager provider exception handling");
                Set<Label> handlers=Set.copyOf(providerCatches.values());
                Map<String,Label> parentCatches=callHandlers(method,AUTH+"AuthenticationManager");
                boolean parentShape=parentCatches.keySet().equals(Set.of(NOT_FOUND,CORE+"AuthenticationException"))&&
                    parentCatches.values().stream().distinct().count()==2&&parentCatches.values().stream().noneMatch(handlers::contains);
                Map<Label,Boolean> parentHandlers=parentShape?Map.of(parentCatches.get(NOT_FOUND),true,
                    parentCatches.get(CORE+"AuthenticationException"),false):Map.of();
                Scope scope=new Scope(handlers,parentHandlers);
                byte[] transformed=format.transformClass(model,(builder,element)->{
                    if(element==method)builder.transformMethod(method,MethodTransform.transformingCode(scope));
                    else builder.with(element);
                });
                if(scope.supports!=1||scope.authenticates!=1||scope.parents!=1||scope.handlers!=handlers.size()||
                    scope.parentHandlers!=parentHandlers.size()||scope.returns!=1)
                    throw new IllegalStateException("Unsupported ProviderManager bytecode shape");
                SecurityTraceRuntime.instrumented(HOOK);
                return transformed;
            }catch(Throwable failure){
                ObserverRuntime.warning("Spring Security ProviderManager trace unavailable ("+failure.getClass().getSimpleName()+")");
                return null;
            }
        }
    }

    private static Map<String,Label> callHandlers(MethodModel method,String owner){
        var code=method.code().orElseThrow();
        List<CodeElement> elements=code.elementList();
        int invoke=-1;
        Map<Label,Integer> labels=new LinkedHashMap<>();
        for(int at=0;at<elements.size();at++){
            CodeElement element=elements.get(at);
            if(element instanceof LabelTarget target)labels.put(target.label(),at);
            if(call(element,owner,"authenticate",AUTHENTICATE)){
                if(invoke>=0)return Map.of();
                invoke=at;
            }
        }
        Map<String,Label> found=new LinkedHashMap<>();
        for(ExceptionCatch item:code.exceptionHandlers()){
            if(invoke<=labels.getOrDefault(item.tryStart(),Integer.MAX_VALUE)||invoke>=labels.getOrDefault(item.tryEnd(),-1))continue;
            String caught=item.catchType().map(type->type.asInternalName()).orElse("");
            if(found.put(caught,item.handler())!=null)return Map.of();
        }
        return found;
    }
    private static boolean call(CodeElement element,String owner,String name,String descriptor){
        return element instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals(owner)&&
            invoke.name().equalsString(name)&&invoke.type().equalsString(descriptor);
    }
    private static final class Scope implements CodeTransform {
        final Set<Label> catches;
        final Map<Label,Boolean> parentCatches;
        int token,supports,authenticates,parents,handlers,parentHandlers,returns;
        Label first,last,failed;
        Scope(Set<Label> catches,Map<Label,Boolean> parentCatches){this.catches=catches;this.parentCatches=parentCatches;}
        @Override public void atStart(CodeBuilder code){
            token=code.allocateLocal(TypeKind.REFERENCE);
            code.aload(0).invokestatic(HELPER,"enter",MethodTypeDesc.of(OBJECT,OBJECT)).astore(token);
            first=code.newLabel();last=code.newLabel();failed=code.newLabel();
            code.labelBinding(first);
        }
        @Override public void accept(CodeBuilder code,CodeElement element){
            if(call(element,AUTH+"AuthenticationProvider","supports","(Ljava/lang/Class;)Z")){
                supports++;
                code.dup2().pop().aload(token).invokestatic(HELPER,"checking",MethodTypeDesc.of(VOID,OBJECT,OBJECT)).with(element);
                code.dup().aload(token).invokestatic(HELPER,"supports",MethodTypeDesc.of(VOID,BOOLEAN,OBJECT));
            }else if(call(element,AUTH+"AuthenticationProvider","authenticate",AUTHENTICATE)){
                authenticates++;
                code.dup2().pop().aload(token).invokestatic(HELPER,"calling",MethodTypeDesc.of(VOID,OBJECT,OBJECT)).with(element);
                isNonNull(code,"result");
            }else if(call(element,AUTH+"AuthenticationManager","authenticate",AUTHENTICATE)){
                parents++;
                code.dup2().pop().aload(token);
                if(parentCatches.isEmpty())code.iconst_0();else code.iconst_1();
                code.invokestatic(HELPER,"delegated",MethodTypeDesc.of(VOID,OBJECT,OBJECT,BOOLEAN)).with(element);
                if(!parentCatches.isEmpty())code.dup().aload(token)
                    .invokestatic(HELPER,"parentReturned",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
            }else if(element instanceof LabelTarget target&&catches.contains(target.label())){
                handlers++;
                code.with(element).dup().aload(token).invokestatic(HELPER,"caught",MethodTypeDesc.of(VOID,THROWABLE,OBJECT));
            }else if(element instanceof LabelTarget target&&parentCatches.containsKey(target.label())){
                parentHandlers++;
                code.with(element).dup().aload(token);
                if(parentCatches.get(target.label()))code.iconst_1();else code.iconst_0();
                code.invokestatic(HELPER,"parentCaught",MethodTypeDesc.of(VOID,THROWABLE,OBJECT,BOOLEAN));
            }else{
                if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE){
                    returns++;
                    code.dup().aload(token).invokestatic(HELPER,"returned",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                }
                code.with(element);
            }
        }
        private void isNonNull(CodeBuilder code,String hook){
            Label nonNull=code.newLabel(),done=code.newLabel();
            code.dup().ifnonnull(nonNull).iconst_0().goto_(done).labelBinding(nonNull).iconst_1().labelBinding(done)
                .aload(token).invokestatic(HELPER,hook,MethodTypeDesc.of(VOID,BOOLEAN,OBJECT));
        }
        @Override public void atEnd(CodeBuilder code){
            code.labelBinding(last).labelBinding(failed).dup().aload(token)
                .invokestatic(HELPER,"failed",MethodTypeDesc.of(VOID,THROWABLE,OBJECT)).athrow().exceptionCatchAll(first,last,failed);
        }
    }
}
