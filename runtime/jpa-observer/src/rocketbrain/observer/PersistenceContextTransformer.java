package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

final class PersistenceContextTransformer implements ClassFileTransformer {
    static final String CONTEXT="org/springframework/context/support/AbstractApplicationContext";
    static final String FACTORY="org/springframework/orm/jpa/AbstractEntityManagerFactoryBean";
    static final String UNIT_INFO="org/springframework/orm/jpa/persistenceunit/SpringPersistenceUnitInfo$SmartPersistenceUnitInfoInvocationHandler";
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.PersistenceContextRuntime");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object"), STRING=ClassDesc.of("java.lang.String");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V");
    private static final ClassDesc PARENT=ClassDesc.of("org.springframework.context.ApplicationContext");
    private static final ClassDesc BEAN_FACTORY=ClassDesc.of("org.springframework.beans.factory.BeanFactory");

    private final Instrumentation instrumentation;
    PersistenceContextTransformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}

    public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
        PersistenceContextRuntime.classDefined(loader,name,bytes,redefining!=null);
        if(!CONTEXT.equals(name)&&!FACTORY.equals(name)&&!UNIT_INFO.equals(name))return null;
        try{
            if(Class.forName(PersistenceContextRuntime.class.getName(),false,loader)!=PersistenceContextRuntime.class)
                throw new IllegalStateException("Observer helper unavailable");
            if(module!=null&&module.isNamed()&&!module.canRead(PersistenceContextRuntime.class.getModule()))
                instrumentation.redefineModule(module,Set.of(PersistenceContextRuntime.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
            var classFile=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            ClassModel model=classFile.parse(bytes);
            boolean context=CONTEXT.equals(name), factory=FACTORY.equals(name);
            if(context&&(!field(model,"id",STRING)||!field(model,"parent",PARENT))||
                factory&&(!field(model,"beanFactory",BEAN_FACTORY)||!field(model,"beanName",STRING)))
                throw new IllegalStateException("Unrecognized Spring metadata fields");
            Set<String> methods=new HashSet<>();
            byte[] result=classFile.transformClass(model,(builder,element)->{
                if(element instanceof MethodModel method){
                    var hook=context?contextHook(method,methods):factory?factoryHook(method,methods):unitHook(method,methods);
                    if(hook!=null){
                        builder.transformMethod(method,MethodTransform.transformingCode(hook));
                        return;
                    }
                }
                builder.with(element);
            });
            Set<String> expected=context?Set.of("prepareBeanFactory","finishRefresh","doClose","setId","setParent"):factory?Set.of("buildNativeEntityManagerFactory"):Set.of("invoke");
            if(!methods.equals(expected))throw new IllegalStateException("Unrecognized Spring lifecycle hooks");
            ObserverRuntime.instrumented(name);
            return result;
        }catch(Throwable failure){
            ObserverRuntime.warning("Spring persistence context observation unavailable: "+name);
            return null;
        }
    }

    private static boolean field(ClassModel model,String name,ClassDesc type){
        return model.fields().stream().anyMatch(field->field.fieldName().equalsString(name)&&field.fieldType().equalsString(type.descriptorString()));
    }

    private static CodeTransform contextHook(MethodModel method,Set<String> matched){
        String name=method.methodName().stringValue(), signature=method.methodType().stringValue();
        String expected=switch(name){
            case "prepareBeanFactory" -> "(Lorg/springframework/beans/factory/config/ConfigurableListableBeanFactory;)V";
            case "setId" -> "(Ljava/lang/String;)V";
            case "setParent" -> "(Lorg/springframework/context/ApplicationContext;)V";
            case "finishRefresh","doClose" -> "()V";
            default -> null;
        };
        if(!signature.equals(expected)||method.code().isEmpty()||!matched.add(name))return null;
        ClassDesc owner=ClassDesc.of(CONTEXT.replace('/','.'));
        return (code,element)->{
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.VOID){
                code.aload(0);
                switch(name){
                    case "prepareBeanFactory" -> code.aload(1).aload(0).getfield(owner,"id",STRING).aload(0).getfield(owner,"parent",PARENT)
                        .invokestatic(HELPER,"contextPrepared",MethodTypeDesc.of(VOID,OBJECT,OBJECT,STRING,OBJECT));
                    case "finishRefresh" -> code.invokestatic(HELPER,"contextReady",MethodTypeDesc.of(VOID,OBJECT));
                    case "doClose" -> code.invokestatic(HELPER,"contextClosed",MethodTypeDesc.of(VOID,OBJECT));
                    default -> code.aload(0).getfield(owner,"id",STRING).aload(0).getfield(owner,"parent",PARENT)
                        .invokestatic(HELPER,"contextMetadata",MethodTypeDesc.of(VOID,OBJECT,STRING,OBJECT));
                }
            }
            code.with(element);
        };
    }

    private static CodeTransform unitHook(MethodModel method,Set<String> matched){
        if(!method.methodName().equalsString("invoke")||!method.methodType().equalsString("(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;")||
            method.code().isEmpty()||!matched.add("invoke"))return null;
        return (code,element)->{
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE){
                code.dup().aload(1).aload(2).invokestatic(HELPER,"unitNameObserved",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
            }
            code.with(element);
        };
    }

    private static CodeTransform factoryHook(MethodModel method,Set<String> matched){
        String name="buildNativeEntityManagerFactory";
        if(!method.methodName().equalsString(name)||!method.methodType().equalsString("()Ljakarta/persistence/EntityManagerFactory;")||
            method.code().isEmpty()||!matched.add(name))return null;
        ClassDesc owner=ClassDesc.of(FACTORY.replace('/','.'));
        return (code,element)->{
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE){
                code.dup().aload(0).aload(0).getfield(owner,"beanFactory",BEAN_FACTORY).aload(0).getfield(owner,"beanName",STRING)
                    .invokestatic(HELPER,"factoryBuilt",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT,STRING));
            }
            code.with(element);
        };
    }
}
