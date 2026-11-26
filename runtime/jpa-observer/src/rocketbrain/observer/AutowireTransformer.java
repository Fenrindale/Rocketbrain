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

final class AutowireTransformer implements ClassFileTransformer {
    static final String CONSTRUCTOR="org/springframework/beans/factory/support/ConstructorResolver";
    static final String FACTORY="org/springframework/beans/factory/support/DefaultListableBeanFactory";
    static final String MEMBERS=FACTORY+"#member-autowire";
    private static final String DESCRIPTOR="Lorg/springframework/beans/factory/config/DependencyDescriptor;";
    private static final String TRAILING="Ljava/lang/String;Ljava/util/Set;Lorg/springframework/beans/TypeConverter;";
    private static final String RESULT="Ljava/lang/Object;";
    private static final String RESOLVE="("+DESCRIPTOR+TRAILING+")"+RESULT;
    private static final String OPTIONAL="("+DESCRIPTOR+"Ljava/lang/String;Ljava/util/Set;[Ljava/lang/Object;)Ljava/util/Optional;";
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.AutowireRuntime");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object"), STRING=ClassDesc.of("java.lang.String");
    private static final ClassDesc VOID=ClassDesc.ofDescriptor("V");
    private static final ClassDesc BEANS=ClassDesc.of("org.springframework.beans.factory.support.AbstractAutowireCapableBeanFactory");
    private final Instrumentation instrumentation;

    AutowireTransformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}

    public byte[] transform(Module module,ClassLoader loader,String type,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
        if(!CONSTRUCTOR.equals(type)&&!FACTORY.equals(type))return null;
        try{
            if(Class.forName(AutowireRuntime.class.getName(),false,loader)!=AutowireRuntime.class)
                throw new IllegalStateException("Observer helper unavailable");
            if(module!=null&&module.isNamed()&&!module.canRead(AutowireRuntime.class.getModule()))
                instrumentation.redefineModule(module,Set.of(AutowireRuntime.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
            var cf=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            var model=cf.parse(bytes);
            boolean constructor=CONSTRUCTOR.equals(type);
            if(constructor&&!model.fields().stream().anyMatch(value->value.fieldName().equalsString("beanFactory")&&
                value.fieldType().equalsString(BEANS.descriptorString())))throw new IllegalStateException("Unknown constructor owner");
            int[] methods={0}, selected={0}, suggested={0}, ambiguity={0};
            byte[] result=cf.transformClass(model,(builder,element)->{
                if(element instanceof MethodModel method&&method.code().isPresent()&&supported(method,constructor)){
                    methods[0]++;
                    builder.transformMethod(method,MethodTransform.transformingCode(constructor?new ResolutionScope(true):
                        (code,instruction)->{
                            if(call(instruction,"java/util/Set","add","(Ljava/lang/Object;)Z")){
                                selected[0]++;
                                code.dup().aload(0).aload(1).invokestatic(HELPER,"selected",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
                            }
                            if(call(instruction,"org/springframework/beans/factory/config/DependencyDescriptor",
                                "resolveNotUnique","(Lorg/springframework/core/ResolvableType;Ljava/util/Map;)Ljava/lang/Object;")){
                                ambiguity[0]++;
                                code.aload(0).aload(1).invokestatic(HELPER,"ambiguous",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                            }
                            code.with(instruction);
                            if(call(instruction,"org/springframework/beans/factory/support/AutowireCandidateResolver",
                                "getSuggestedName","("+DESCRIPTOR+")Ljava/lang/String;")){
                                suggested[0]++;
                                code.dup().aload(0).aload(1).invokestatic(HELPER,"suggested",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
                            }
                        }));
                }else builder.with(element);
            });
            if(methods[0]!=1||!constructor&&(selected[0]!=2||suggested[0]!=1||ambiguity[0]!=1))
                throw new IllegalStateException("Unknown Spring constructor resolution shape");
            ObserverRuntime.instrumented(type);
            if(!constructor){
                try{
                    byte[] members=memberHooks(cf,cf.parse(result));
                    ObserverRuntime.instrumented(MEMBERS);
                    return members;
                }catch(Throwable ignored){
                    ObserverRuntime.warning("Spring field and method observation unavailable for this resolution shape.");
                }
            }
            return result;
        }catch(Throwable ignored){
            ObserverRuntime.warning("Spring constructor observation unavailable: "+type);
            return null;
        }
    }

    private static byte[] memberHooks(ClassFile format,java.lang.classfile.ClassModel model){
        // All added shapes are optional relative to the existing constructor instrumentation.
        int[] matched={0,0,0,0,0,0,0,0};
        byte[] result=format.transformClass(model,(builder,element)->{
            if(!(element instanceof MethodModel method)||method.code().isEmpty()){builder.with(element);return;}
            String name=method.methodName().stringValue(), signature=method.methodType().stringValue();
            if(name.equals("resolveDependency")&&signature.equals(RESOLVE)&&method.code().orElseThrow().elementStream()
                .filter(instruction->call(instruction,FACTORY,"doResolveDependency",RESOLVE)).count()==1){
                matched[0]++;
                builder.transformMethod(method,MethodTransform.transformingCode(new ResolutionScope(false)));
            }else if(name.equals("doResolveDependency")&&signature.equals(RESOLVE)){
                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                    code.with(instruction);
                    if(call(instruction,"java/util/Map","isEmpty","()Z")){
                        matched[1]++;
                        code.dup().aload(0).aload(1).invokestatic(HELPER,"emptyCandidates",
                            MethodTypeDesc.of(VOID,ClassDesc.ofDescriptor("Z"),OBJECT,OBJECT));
                    }
                }));
            }else if(name.equals("createOptionalDependency")&&signature.equals(OPTIONAL)){
                matched[2]++;
                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                    code.with(instruction);
                    if(instruction instanceof InvokeInstruction call&&call.owner().asInternalName().startsWith(FACTORY+"$")&&
                        call.name().equalsString("<init>")&&call.type().equalsString("(L"+FACTORY+";"+DESCRIPTOR+"[Ljava/lang/Object;)V")){
                        matched[3]++;
                        code.dup().aload(0).aload(1)
                            .invokestatic(HELPER,"optional",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
                    }
                }));
            }else if(Set.of("resolveMultipleBeans","resolveMultipleBeanCollection","resolveMultipleBeanMap").contains(name)&&
                signature.equals(RESOLVE)){
                int index=name.equals("resolveMultipleBeans")?4:name.equals("resolveMultipleBeanCollection")?5:6;
                matched[7]++;
                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                    if(call(instruction,"java/util/Set","addAll","(Ljava/util/Collection;)Z")){
                        matched[index]++;
                        code.dup().aload(0).aload(1)
                            .invokestatic(HELPER,"aggregated",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
                    }
                    code.with(instruction);
                }));
            }else builder.with(element);
        });
        if(!java.util.Arrays.equals(matched,new int[]{1,1,1,1,2,1,1,3}))
            throw new IllegalStateException("Unknown Spring member resolution shape");
        return result;
    }

    private static boolean supported(MethodModel method,boolean constructor){
        if(constructor)return method.methodName().equalsString("resolveAutowiredArgument")&&
            method.methodType().equalsString("("+DESCRIPTOR+"Ljava/lang/Class;"+TRAILING+"Z)"+RESULT)&&
            method.code().orElseThrow().elementStream().filter(element->call(element,
                "org/springframework/beans/factory/support/AbstractAutowireCapableBeanFactory","resolveDependency",
                "("+DESCRIPTOR+TRAILING+")"+RESULT)).count()==1;
        return method.methodName().equalsString("doResolveDependency")&&method.methodType().equalsString("("+DESCRIPTOR+TRAILING+")"+RESULT);
    }

    private static boolean call(CodeElement element,String owner,String name,String descriptor){
        return element instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals(owner)&&
            invoke.name().equalsString(name)&&invoke.type().equalsString(descriptor);
    }

    private static final class ResolutionScope implements CodeTransform {
        private final boolean constructor;
        private Label start,end,handler;
        private int token;
        ResolutionScope(boolean constructor){this.constructor=constructor;}
        public void atStart(CodeBuilder code){
            token=code.allocateLocal(TypeKind.REFERENCE);
            if(constructor){
                code.aload(0).getfield(ClassDesc.of(CONSTRUCTOR.replace('/','.')),"beanFactory",BEANS).aload(1).aload(3)
                    .invokestatic(HELPER,"start",MethodTypeDesc.of(OBJECT,OBJECT,OBJECT,STRING));
            }else{
                code.aload(0).aload(1).aload(2).aload(3)
                    .invokestatic(HELPER,"startMember",MethodTypeDesc.of(OBJECT,OBJECT,OBJECT,STRING,OBJECT));
            }
            code.astore(token);
            start=code.newLabel();end=code.newLabel();handler=code.newLabel();
            code.labelBinding(start);
        }
        public void accept(CodeBuilder code,CodeElement element){
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE)
                code.dup().aload(token).aconst_null().invokestatic(HELPER,"end",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT));
            code.with(element);
        }
        public void atEnd(CodeBuilder code){
            int error=code.allocateLocal(TypeKind.REFERENCE);
            code.labelBinding(end).labelBinding(handler).astore(error).aconst_null().aload(token).aload(error)
                .invokestatic(HELPER,"end",MethodTypeDesc.of(VOID,OBJECT,OBJECT,OBJECT))
                .aload(error).athrow().exceptionCatchAll(start,end,handler);
        }
    }
}
