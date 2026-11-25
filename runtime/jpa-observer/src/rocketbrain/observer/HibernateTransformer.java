package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.Label;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.Map;
import java.util.Set;

final class HibernateTransformer implements ClassFileTransformer {
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.ObserverRuntime");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object"),STRING=ClassDesc.of("java.lang.String"),THROWABLE=ClassDesc.of("java.lang.Throwable");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V");
    private static final String FACTORY_CONSTRUCTOR="(Lorg/hibernate/boot/spi/MetadataImplementor;Lorg/hibernate/boot/spi/SessionFactoryOptions;Lorg/hibernate/boot/spi/BootstrapContext;)V";
    private final Instrumentation instrumentation;
    HibernateTransformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}
    public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
        boolean session="org/hibernate/internal/AbstractSharedSessionContract".equals(name),translator="org/hibernate/query/hql/internal/StandardHqlTranslator".equals(name);
        boolean factory="org/hibernate/internal/SessionFactoryImpl".equals(name);
        if(!session&&!translator&&!factory)return null;
        try {
            if(Class.forName(ObserverRuntime.class.getName(),false,loader)!=ObserverRuntime.class)throw new IllegalStateException("Agent helper not visible to application loader");
            if(module!=null&&module.isNamed()&&!module.canRead(ObserverRuntime.class.getModule()))instrumentation.redefineModule(module,Set.of(ObserverRuntime.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
            ClassFile cf=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            byte[] result=cf.transformClass(cf.parse(bytes),(builder,element)->{
                if(element instanceof MethodModel method){String methodName=method.methodName().stringValue();var type=method.methodTypeSymbol();
                    if(session&&methodName.equals("getFactory")&&type.parameterCount()==0&&type.returnType().isClassOrInterface()){
                        builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{if(instruction instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE)code.dup().invokestatic(HELPER,"factorySeen",MethodTypeDesc.of(VOID,OBJECT));code.with(instruction);}));return;
                    }
                    if(factory && (methodName.equals("<init>") && type.descriptorString().equals(FACTORY_CONSTRUCTOR) || methodName.equals("close") && type.descriptorString().equals("()V"))){
                        String hook=methodName.equals("<init>")?"factorySeen":"factoryClosed";
                        builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                            if(instruction instanceof ReturnInstruction ret && ret.typeKind()==TypeKind.VOID)
                                code.aload(0).invokestatic(HELPER,hook,MethodTypeDesc.of(VOID,OBJECT));
                            code.with(instruction);
                        }));
                        return;
                    }
                    if(!factory&&!method.flags().has(java.lang.reflect.AccessFlag.STATIC)&&type.parameterCount()>0&&type.parameterType(0).equals(STRING)&&type.returnType().isClassOrInterface()&&(translator?methodName.equals("translate"):Set.of("createQuery","createSelectionQuery","createMutationQuery").contains(methodName))){builder.transformMethod(method,MethodTransform.transformingCode(new Hook(session)));return;}
                }
                builder.with(element);
            });
            ObserverRuntime.instrumented(name);return result;
        }catch(Throwable failure){ObserverRuntime.warning("Instrumentation unavailable: "+name+" ("+failure.getClass().getSimpleName()+")");return null;}
    }
    private static final class Hook implements CodeTransform {
        private final boolean session;private Label start,end,handler;
        Hook(boolean session){this.session=session;}
        public void atStart(CodeBuilder code){
            if(session)code.aload(0).aload(1).invokestatic(HELPER,"queryStart",MethodTypeDesc.of(VOID,OBJECT,STRING));
            else code.aload(1).invokestatic(HELPER,"translationStart",MethodTypeDesc.of(VOID,STRING));
            start=code.newLabel();end=code.newLabel();handler=code.newLabel();code.labelBinding(start);
        }
        public void accept(CodeBuilder code,CodeElement element){
            if(element instanceof ReturnInstruction instruction&&instruction.typeKind()==TypeKind.REFERENCE)code.dup().invokestatic(HELPER,session?"querySuccess":"translationSuccess",MethodTypeDesc.of(VOID,OBJECT));
            code.with(element);
        }
        public void atEnd(CodeBuilder code){code.labelBinding(end).labelBinding(handler).dup().invokestatic(HELPER,session?"queryFailure":"translationFailure",MethodTypeDesc.of(VOID,THROWABLE)).athrow().exceptionCatchAll(start,end,handler);}
    }
}
