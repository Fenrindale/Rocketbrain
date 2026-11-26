package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.Label;
import java.lang.classfile.MethodModel;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.FieldInstruction;
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

final class PerformanceTransformer implements ClassFileTransformer {
    static final String MVC="org/springframework/web/servlet/FrameworkServlet";
    static final String ASYNC="org/springframework/web/context/request/async/WebAsyncManager";
    static final String LOADER="org/hibernate/loader/ast/internal/CollectionLoaderSingleKey";
    static final String JDBC="org/hibernate/sql/results/jdbc/internal/DeferredResultSetAccess";
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.PerformanceRuntime");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object");
    private static final ClassDesc STRING=ClassDesc.of("java.lang.String");
    private static final ClassDesc CONTEXT=ClassDesc.of("org.hibernate.sql.exec.spi.ExecutionContext");
    private static final ClassDesc SYSTEM=ClassDesc.of("java.lang.System");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V"), BOOLEAN=ClassDesc.ofDescriptor("Z"), LONG=ClassDesc.ofDescriptor("J");
    private final Instrumentation instrumentation;

    PerformanceTransformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}

    public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
        boolean descriptor=JdbcBindHook.owner(name);
        if(!MVC.equals(name)&&!ASYNC.equals(name)&&!LOADER.equals(name)&&!JDBC.equals(name)&&!descriptor)return null;
        try{
            if(Class.forName(PerformanceRuntime.class.getName(),false,loader)!=PerformanceRuntime.class)
                throw new IllegalStateException("Performance observer is not visible to this class loader");
            if(module!=null&&module.isNamed()&&!module.canRead(PerformanceRuntime.class.getModule())){
                instrumentation.redefineModule(module,Set.of(PerformanceRuntime.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
            }
            ClassFile cf=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            var model=cf.parse(bytes);
            if(descriptor)return JdbcBindHook.transform(cf,model);
            if(ASYNC.equals(name)){
                byte[] result=asyncHook(cf,model);
                ObserverRuntime.instrumented(name);
                return result;
            }
            if(JDBC.equals(name)&&(!field(model,"executionContext",CONTEXT.descriptorString())||!field(model,"finalSql",STRING.descriptorString()))){
                throw new IllegalStateException("Unrecognized JDBC fields");
            }
            int[] matches={0}, executions={0};
            byte[] result=cf.transformClass(model,(builder,element)->{
                if(element instanceof MethodModel method&&supported(name,method)){
                    matches[0]++;
                    CodeTransform hook=JDBC.equals(name)?jdbcHook(executions,method.code()
                        .map(code->code.elementStream().filter(PerformanceTransformer::bindParameters).count()==1).orElse(false)):
                        new ScopedHook(MVC.equals(name));
                    builder.transformMethod(method,MethodTransform.transformingCode(hook));
                }else builder.with(element);
            });
            if(matches[0]!=1||(JDBC.equals(name)&&executions[0]!=1))throw new IllegalStateException("Unrecognized performance hook shape");
            ObserverRuntime.instrumented(name);
            return result;
        }catch(Throwable failure){
            ObserverRuntime.warning("Performance observation unavailable: "+name+" ("+failure.getClass().getSimpleName()+")");
            return null;
        }
    }

    private enum AsyncHook { SCHEDULE, WORKER, RESULT }

    private static boolean call(CodeElement element,String owner,String name,String descriptor){
        return element instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals(owner)&&
            invoke.name().equalsString(name)&&invoke.type().equalsString(descriptor);
    }

    private static boolean callableCall(CodeElement element){
        return call(element,"java/util/concurrent/Callable","call","()Ljava/lang/Object;");
    }

    private static boolean startAsync(CodeElement element){
        return call(element,ASYNC,"startAsyncProcessing","([Ljava/lang/Object;)V");
    }

    private static boolean storedResult(CodeElement element){
        return element instanceof FieldInstruction write&&write.opcode()==Opcode.PUTFIELD&&
            write.owner().asInternalName().equals(ASYNC)&&write.name().equalsString("concurrentResult")&&
            write.type().equalsString("Ljava/lang/Object;");
    }

    private static AsyncHook asyncShape(MethodModel method){
        String name=method.methodName().stringValue(),signature=method.methodType().stringValue();
        var elements=method.code().map(body->body.elementStream().toList()).orElseGet(java.util.List::of);
        String async="org/springframework/web/context/request/async/";
        if(name.equals("startCallableProcessing")&&signature.equals("(L"+async+"WebAsyncTask;[Ljava/lang/Object;)V")&&
            elements.stream().filter(PerformanceTransformer::startAsync).count()==1&&
            elements.stream().filter(element->call(element,"org/springframework/core/task/AsyncTaskExecutor","submit",
                "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;")).count()==1)return AsyncHook.SCHEDULE;
        if(name.startsWith("lambda$startCallableProcessing$")&&
            signature.equals("(L"+async+"CallableInterceptorChain;Ljava/util/concurrent/Callable;)V")&&
            elements.stream().filter(PerformanceTransformer::callableCall).count()==1&&
            elements.stream().filter(element->call(element,ASYNC,"setConcurrentResultAndDispatch",
                "(Ljava/lang/Object;)V")).count()==1)return AsyncHook.WORKER;
        if(name.equals("setConcurrentResultAndDispatch")&&signature.equals("(Ljava/lang/Object;)V")&&
            elements.stream().filter(PerformanceTransformer::storedResult).count()==1&&
            elements.stream().filter(element->call(element,"java/util/concurrent/atomic/AtomicReference","compareAndSet",
                "(Ljava/lang/Object;Ljava/lang/Object;)Z")).count()==1&&
            elements.stream().filter(element->call(element,async+"AsyncWebRequest","dispatch","()V")).count()==1)return AsyncHook.RESULT;
        return null;
    }

    private static byte[] asyncHook(ClassFile cf,java.lang.classfile.ClassModel model){
        Set<AsyncHook> matches=java.util.EnumSet.noneOf(AsyncHook.class);
        byte[] instrumented=cf.transformClass(model,(builder,element)->{
            if(element instanceof MethodModel method){
                AsyncHook hook=asyncShape(method);
                if(hook!=null){
                    if(!matches.add(hook))throw new IllegalStateException("Ambiguous async performance hook");
                    CodeTransform transform=switch(hook){
                        case SCHEDULE -> (code,instruction)->{
                            code.with(instruction);
                            if(startAsync(instruction))code.aload(0).invokestatic(HELPER,"callableScheduled",MethodTypeDesc.of(VOID,OBJECT));
                        };
                        case WORKER -> new CallableWorker();
                        case RESULT -> (code,instruction)->{
                            code.with(instruction);
                            if(storedResult(instruction))code.aload(0).aload(1)
                                .invokestatic(HELPER,"callableAccepted",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                        };
                    };
                    builder.transformMethod(method,MethodTransform.transformingCode(transform));
                    return;
                }
            }
            builder.with(element);
        });
        if(matches.size()!=AsyncHook.values().length)throw new IllegalStateException("Unrecognized Spring MVC Callable lifecycle");
        return instrumented;
    }

    private static final class CallableWorker implements CodeTransform {
        private Label start,end,handler;
        private int token;

        public void atStart(CodeBuilder code){
            token=code.allocateLocal(TypeKind.REFERENCE);
            code.aload(0).invokestatic(HELPER,"callableWorkerStart",MethodTypeDesc.of(OBJECT,OBJECT)).astore(token);
            start=code.newLabel();end=code.newLabel();handler=code.newLabel();
            code.labelBinding(start);
        }

        public void accept(CodeBuilder code,CodeElement element){
            if(element instanceof ReturnInstruction result&&result.typeKind()==TypeKind.VOID)finish(code,true);
            code.with(element);
            if(callableCall(element))code.aload(token).invokestatic(HELPER,"callableReturned",MethodTypeDesc.of(VOID,OBJECT));
        }

        private void finish(CodeBuilder code,boolean success){
            code.aload(token);
            if(success)code.iconst_1();else code.iconst_0();
            code.invokestatic(HELPER,"callableWorkerEnd",MethodTypeDesc.of(VOID,OBJECT,BOOLEAN));
        }

        public void atEnd(CodeBuilder code){
            code.labelBinding(end).labelBinding(handler);
            finish(code,false);
            code.athrow().exceptionCatchAll(start,end,handler);
        }
    }

    private static boolean field(java.lang.classfile.ClassModel model,String name,String descriptor){
        return model.fields().stream().anyMatch(field->field.fieldName().equalsString(name)&&field.fieldType().equalsString(descriptor));
    }

    private static boolean supported(String owner,MethodModel method){
        String name=method.methodName().stringValue(), signature=method.methodType().stringValue();
        return switch(owner){
            case MVC -> name.equals("processRequest")&&signature.equals("(Ljakarta/servlet/http/HttpServletRequest;Ljakarta/servlet/http/HttpServletResponse;)V");
            case LOADER -> name.equals("load")&&signature.equals("(Ljava/lang/Object;Lorg/hibernate/engine/spi/SharedSessionContractImplementor;)Lorg/hibernate/collection/spi/PersistentCollection;");
            case JDBC -> name.equals("executeQuery")&&signature.equals("()V");
            default -> false;
        };
    }

    private static boolean bindParameters(CodeElement element){
        return element instanceof InvokeInstruction call&&call.owner().asInternalName().equals(JDBC)&&
            call.name().equalsString("bindParameters")&&call.type().equalsString("(Ljava/sql/PreparedStatement;)V");
    }

    private static CodeTransform jdbcHook(int[] executions,boolean observeBindings){
        ClassDesc owner=ClassDesc.of(JDBC.replace('/','.'));
        return new CodeTransform(){
            private Label start,end,handler;

            public void atStart(CodeBuilder code){
                code.invokestatic(HELPER,"selectStart",MethodTypeDesc.of(VOID));
                start=code.newLabel();end=code.newLabel();handler=code.newLabel();
                code.labelBinding(start);
            }

            public void accept(CodeBuilder code,CodeElement instruction){
                if(instruction instanceof InvokeInstruction call){
                    if(observeBindings&&bindParameters(call)){
                        code.dup().invokestatic(HELPER,"bindStart",MethodTypeDesc.of(VOID,OBJECT));
                        code.with(instruction);
                        code.invokestatic(HELPER,"bindEnd",MethodTypeDesc.of(VOID));
                        return;
                    }
                    if(call.owner().asInternalName().equals("java/sql/PreparedStatement")&&
                        call.name().equalsString("executeQuery")&&call.type().equalsString("()Ljava/sql/ResultSet;")){
                        executions[0]++;
                        int statement=code.allocateLocal(TypeKind.REFERENCE),started=code.allocateLocal(TypeKind.LONG);
                        code.dup().astore(statement).invokestatic(SYSTEM,"nanoTime",MethodTypeDesc.of(LONG)).lstore(started);
                        code.with(instruction);
                        code.invokestatic(SYSTEM,"nanoTime",MethodTypeDesc.of(LONG)).lload(started).lsub().lstore(started);
                        code.aload(statement).aload(0).getfield(owner,"executionContext",CONTEXT);
                        code.aload(0).getfield(owner,"finalSql",STRING).lload(started)
                            .invokestatic(HELPER,"selectExecuted",MethodTypeDesc.of(VOID,OBJECT,OBJECT,STRING,LONG));
                        return;
                    }
                }
                if(instruction instanceof ReturnInstruction result&&result.typeKind()==TypeKind.VOID)finish(code);
                code.with(instruction);
            }

            private void finish(CodeBuilder code){code.invokestatic(HELPER,"selectEnd",MethodTypeDesc.of(VOID));}

            public void atEnd(CodeBuilder code){
                code.labelBinding(end).labelBinding(handler);
                finish(code);
                code.athrow().exceptionCatchAll(start,end,handler);
            }
        };
    }

    private static final class ScopedHook implements CodeTransform{
        private final boolean request;
        private Label start,end,handler;
        ScopedHook(boolean request){this.request=request;}

        public void atStart(CodeBuilder code){
            if(request)code.aload(1).invokestatic(HELPER,"requestStart",MethodTypeDesc.of(VOID,OBJECT));
            else code.aload(0).aload(1).aload(2).invokestatic(HELPER,"collectionStart",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
            start=code.newLabel();end=code.newLabel();handler=code.newLabel();
            code.labelBinding(start);
        }
        private void finish(CodeBuilder code,boolean success){
            if(request){
                if(success)code.iconst_1();else code.iconst_0();
                code.invokestatic(HELPER,"requestEnd",MethodTypeDesc.of(VOID,BOOLEAN));
            }else code.invokestatic(HELPER,"collectionEnd",MethodTypeDesc.of(VOID));
        }
        public void accept(CodeBuilder code,CodeElement element){
            if(element instanceof ReturnInstruction result&&result.typeKind()==(request?TypeKind.VOID:TypeKind.REFERENCE))finish(code,true);
            code.with(element);
        }
        public void atEnd(CodeBuilder code){
            code.labelBinding(end).labelBinding(handler);
            finish(code,false);
            code.athrow().exceptionCatchAll(start,end,handler);
        }
    }
}
