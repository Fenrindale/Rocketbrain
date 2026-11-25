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

final class PerformanceTransformer implements ClassFileTransformer {
    static final String MVC="org/springframework/web/servlet/FrameworkServlet";
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
        if(!MVC.equals(name)&&!LOADER.equals(name)&&!JDBC.equals(name))return null;
        try{
            if(Class.forName(PerformanceRuntime.class.getName(),false,loader)!=PerformanceRuntime.class)
                throw new IllegalStateException("Performance observer is not visible to this class loader");
            if(module!=null&&module.isNamed()&&!module.canRead(PerformanceRuntime.class.getModule())){
                instrumentation.redefineModule(module,Set.of(PerformanceRuntime.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
            }
            ClassFile cf=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            var model=cf.parse(bytes);
            if(JDBC.equals(name)&&(!field(model,"executionContext",CONTEXT.descriptorString())||!field(model,"finalSql",STRING.descriptorString()))){
                throw new IllegalStateException("Unrecognized JDBC fields");
            }
            int[] matches={0}, executions={0};
            byte[] result=cf.transformClass(model,(builder,element)->{
                if(element instanceof MethodModel method&&supported(name,method)){
                    matches[0]++;
                    CodeTransform hook=JDBC.equals(name)?jdbcHook(executions):new ScopedHook(MVC.equals(name));
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

    private static CodeTransform jdbcHook(int[] executions){
        ClassDesc owner=ClassDesc.of(JDBC.replace('/','.'));
        return (code,instruction)->{
            if(instruction instanceof InvokeInstruction call
                &&call.owner().asInternalName().equals("java/sql/PreparedStatement")
                &&call.name().equalsString("executeQuery")&&call.type().equalsString("()Ljava/sql/ResultSet;")){
                executions[0]++;
                int started=code.allocateLocal(TypeKind.LONG);
                code.invokestatic(SYSTEM,"nanoTime",MethodTypeDesc.of(LONG)).lstore(started);
                code.with(instruction);
                code.invokestatic(SYSTEM,"nanoTime",MethodTypeDesc.of(LONG)).lload(started).lsub().lstore(started);
                code.aload(0).getfield(owner,"executionContext",CONTEXT);
                code.aload(0).getfield(owner,"finalSql",STRING).lload(started)
                    .invokestatic(HELPER,"selectExecuted",MethodTypeDesc.of(VOID,OBJECT,STRING,LONG));
            }else code.with(instruction);
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
