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
import java.lang.ref.WeakReference;
import java.security.ProtectionDomain;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Records native Spring resource-local transaction calls. Observers never invoke a transaction operation. */
public final class JpaTransactionTrace {
    private static final String JPA="org/springframework/orm/jpa/";
    private static final String MANAGER=JPA+"JpaTransactionManager";
    private static final String FACTORY=JPA+"AbstractEntityManagerFactoryBean";
    private static final String FACTORY_DESC="Ljakarta/persistence/EntityManagerFactory;";
    private static final String DEFINITION="Lorg/springframework/transaction/TransactionDefinition;";
    private static final String STATUS="org/springframework/transaction/support/DefaultTransactionStatus";
    private static final String ENTITY_TX="jakarta/persistence/EntityTransaction";
    private static final String ARG_OBJECT="Ljava/lang/Object;";
    private static final ClassDesc HELPER=ClassDesc.of("rocketbrain.observer.JpaTransactionTrace");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object"), VOID=ClassDesc.ofDescriptor("V"),
        INT=ClassDesc.ofDescriptor("I"), BOOLEAN=ClassDesc.ofDescriptor("Z");
    private static final int MAX_ACTIVE=96, MAX_RECENT=48, MAX_IDENTITIES=32, MAX_ALIASES=16;
    private static final List<Transaction> active=new ArrayList<>();
    private static final ArrayDeque<Map<String,Object>> recent=new ArrayDeque<>();
    private static final List<Identity> identities=new ArrayList<>();
    private static final List<Alias> aliases=new ArrayList<>();
    private static volatile boolean enabled;
    private static boolean managerHook, factoryHook;
    private static long nextTransaction,nextManager,dropped;

    private record Identity(WeakReference<Object> manager,String id) {}
    private record Alias(WeakReference<Object> proxy,WeakReference<Object> factory) {}
    private static final class Transaction {
        final long id=++nextTransaction, start=System.nanoTime();
        final String startedAt=Instant.now().toString(), managerId, managerType;
        final WeakReference<Object> object;
        final Map<String,Object> stages=new LinkedHashMap<>();
        PersistenceContextRuntime.TransactionOwner owner;
        Boolean readOnly;
        boolean factorySeen, conflictingFactory, conflictingReadOnly;
        Transaction(Object object,String managerId,String managerType){
            this.object=new WeakReference<>(object);this.managerId=managerId;this.managerType=managerType;
        }
    }
    private static final class Operation {
        final Transaction transaction;
        final Hook hook;
        String provider="not-reached";
        Operation(Transaction transaction,Hook hook){this.transaction=transaction;this.hook=hook;}
    }
    private enum Hook {
        BEGIN("doBegin","("+ARG_OBJECT+DEFINITION+")V","begin"),
        COMMIT("doCommit","(L"+STATUS+";)V","commit"),
        ROLLBACK("doRollback","(L"+STATUS+";)V","rollback"),
        CLEANUP("doCleanupAfterCompletion","("+ARG_OBJECT+")V","cleanup");
        final String method, descriptor, key;
        Hook(String method,String descriptor,String key){this.method=method;this.descriptor=descriptor;this.key=key;}
    }

    private JpaTransactionTrace(){}
    static synchronized void configure(boolean option){
        enabled=option;managerHook=false;factoryHook=false;
        active.clear();recent.clear();identities.clear();aliases.clear();dropped=0;
    }
    static boolean enabled(){return enabled;}
    private static synchronized void installed(boolean manager){if(manager)managerHook=true;else factoryHook=true;}
    public static synchronized void factoryProxy(Object proxy,Object nativeFactory){
        try{
            if(!enabled||proxy==null||nativeFactory==null||proxy==nativeFactory)return;
            aliases.removeIf(item->item.proxy().get()==null||item.factory().get()==null);
            if(aliases.stream().anyMatch(item->item.proxy().get()==proxy))return;
            if(aliases.size()<MAX_ALIASES)aliases.add(new Alias(new WeakReference<>(proxy),new WeakReference<>(nativeFactory)));
        }catch(Throwable ignored){}
    }

    private static String managerId(Object manager,boolean create){
        identities.removeIf(item->item.manager().get()==null);
        for(Identity item:identities)if(item.manager().get()==manager)return item.id();
        if(!create||identities.size()>=MAX_IDENTITIES)return null;
        String id="tx-manager-"+ ++nextManager;
        identities.add(new Identity(new WeakReference<>(manager),id));
        return id;
    }
    private static Transaction find(Object object,String manager){
        for(Transaction item:active)if(item.object.get()==object&&item.managerId.equals(manager))return item;
        return null;
    }
    public static synchronized Object enter(Object manager,Object object,int operation){
        if(!enabled||object==null)return null;
        try{
            Hook hook=Hook.values()[operation];
            boolean begin=hook==Hook.BEGIN;
            String managerId=managerId(manager,begin);
            if(managerId==null){if(begin)dropped++;return null;}
            Transaction record=find(object,managerId);
            if(begin){
                int previous=active.size();active.removeIf(item->item.object.get()==null);
                dropped+=previous-active.size();
                String name=manager.getClass().getName();
                if(record!=null||active.size()>=MAX_ACTIVE||name.length()>192||!name.matches("[A-Za-z0-9_.$]+")){
                    dropped++;return null;
                }
                record=new Transaction(object,managerId,name);
                active.add(record);
            }
            return record==null?null:new Operation(record,hook);
        }catch(Throwable ignored){return null;}
    }
    public static synchronized void effectiveFactory(Object value,Object token){
        if(!(token instanceof Operation op)||value==null)return;
        try{
            Object nativeFactory=value;
            for(Alias alias:aliases)if(alias.proxy().get()==value){nativeFactory=alias.factory().get();break;}
            var owner=PersistenceContextRuntime.transactionOwner(nativeFactory);
            Transaction record=op.transaction;
            if(record.factorySeen&&!java.util.Objects.equals(owner,record.owner))record.conflictingFactory=true;
            record.factorySeen=true;record.owner=owner;
        }catch(Throwable ignored){}
    }
    public static synchronized void readOnly(boolean value,Object token){
        if(token instanceof Operation op){
            Transaction record=op.transaction;
            if(record.readOnly!=null&&record.readOnly!=value)record.conflictingReadOnly=true;
            record.readOnly=value;
        }
    }
    public static void reaching(Object token){if(token instanceof Operation op)op.provider="entered";}
    public static void providerReturned(Object token){if(token instanceof Operation op)op.provider="returned";}
    public static synchronized void finished(boolean thrown,Object token){
        if(!(token instanceof Operation op)||!enabled)return;
        try{
            Transaction tx=op.transaction;
            String provider=op.provider.equals("entered")?(thrown?"threw":"unobserved"):op.provider;
            tx.stages.put(op.hook.key,op.hook==Hook.CLEANUP?Map.of("spring",thrown?"threw":"returned"):
                Map.of("spring",thrown?"threw":"returned","provider",provider));
            if(op.hook==Hook.CLEANUP||op.hook==Hook.BEGIN&&thrown)retain(tx);
        }catch(Throwable ignored){}
    }
    private static void retain(Transaction tx){
        if(!active.remove(tx))return;
        Map<String,Object> report=new LinkedHashMap<>();
        report.put("id",tx.id);report.put("managerId",tx.managerId);report.put("managerType",tx.managerType);
        report.put("startedAt",tx.startedAt);report.put("durationMs",Math.min(3600000L,(System.nanoTime()-tx.start)/1000000));
        report.put("readOnly",tx.conflictingReadOnly?null:tx.readOnly);
        var owner=tx.conflictingFactory?null:tx.owner;
        report.put("owner",owner==null?null:Map.of("factoryId",owner.factoryId(),"contextKey",owner.contextKey(),"persistenceUnit",owner.unit()));
        report.put("stages",Map.copyOf(tx.stages));
        if(recent.size()==MAX_RECENT){recent.removeFirst();dropped++;}
        recent.addLast(report);
    }
    static synchronized Map<String,Object> snapshot(){
        return Map.of("enabled",enabled,"state",!enabled?"disabled":managerHook?"ready":"waiting","factoryHook",factoryHook,
            "processId",ProcessHandle.current().pid(),"dropped",dropped,"transactions",List.copyOf(recent));
    }

    static final class Transformer implements ClassFileTransformer {
        private final Instrumentation instrumentation;
        Transformer(Instrumentation instrumentation){this.instrumentation=instrumentation;}
        @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redefining,ProtectionDomain domain,byte[] bytes){
            boolean manager=MANAGER.equals(name);
            if(!manager&&!FACTORY.equals(name))return null;
            try{
                if(Class.forName(JpaTransactionTrace.class.getName(),false,loader)!=JpaTransactionTrace.class)
                    throw new IllegalStateException("Transaction observer helper unavailable");
                if(module!=null&&module.isNamed()&&!module.canRead(JpaTransactionTrace.class.getModule()))
                    instrumentation.redefineModule(module,Set.of(JpaTransactionTrace.class.getModule()),Map.of(),Map.of(),Set.of(),Map.of());
                var classFile=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
                var model=classFile.parse(bytes);
                if(!manager&&model.fields().stream().noneMatch(field->field.fieldName().equalsString("nativeEntityManagerFactory")&&
                    field.fieldType().equalsString(FACTORY_DESC)))throw new IllegalStateException("Unrecognized native factory field");
                Set<Scope> scopes=new HashSet<>();
                int[] proxyReturns={0};
                byte[] result=classFile.transformClass(model,(builder,element)->{
                    if(element instanceof MethodModel method&&method.code().isPresent()){
                        if(manager)for(Hook hook:Hook.values())if(method.methodName().equalsString(hook.method)&&method.methodType().equalsString(hook.descriptor)){
                            Scope scope=new Scope(hook);scopes.add(scope);
                            builder.transformMethod(method,MethodTransform.transformingCode(scope));return;
                        }
                        if(!manager&&method.methodName().equalsString("createEntityManagerFactoryProxy")&&method.methodType().equalsString("("+FACTORY_DESC+")"+FACTORY_DESC)){
                            builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                                if(instruction instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.REFERENCE){
                                    proxyReturns[0]++;
                                    code.dup().aload(0).getfield(ClassDesc.of(FACTORY.replace('/','.')),"nativeEntityManagerFactory",
                                        ClassDesc.ofDescriptor(FACTORY_DESC)).invokestatic(HELPER,"factoryProxy",MethodTypeDesc.of(VOID,OBJECT,OBJECT));
                                }
                                code.with(instruction);
                            }));return;
                        }
                    }
                    builder.with(element);
                });
                if(manager&&(scopes.size()!=Hook.values().length||scopes.stream().anyMatch(scope->!scope.supported()))||
                    !manager&&proxyReturns[0]!=1)throw new IllegalStateException("Unsupported Spring JPA transaction bytecode shape");
                installed(manager);
                return result;
            }catch(Throwable failure){
                ObserverRuntime.warning("Spring JPA transaction observation unavailable for "+name+" ("+failure.getClass().getSimpleName()+")");
                return null;
            }
        }
    }

    private static boolean call(CodeElement element,String owner,String name,String descriptor){
        return element instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals(owner)&&
            invoke.name().equalsString(name)&&invoke.type().equalsString(descriptor);
    }
    private static final class Scope implements CodeTransform {
        final Hook hook;
        Label first,last,failed;
        int local, objects,factories, flags, calls, exits;
        Scope(Hook hook){this.hook=hook;}
        boolean supported(){
            return exits==1&&switch(hook){
                case BEGIN -> objects==0&&factories==1&&flags==2&&calls==1;
                case COMMIT,ROLLBACK -> objects==1&&factories==0&&flags==0&&calls==1;
                case CLEANUP -> objects==0&&factories==0&&flags==0&&calls==0;
            };
        }
        @Override public void atStart(CodeBuilder code){
            local=code.allocateLocal(TypeKind.REFERENCE);
            code.aconst_null().astore(local);
            if(hook==Hook.BEGIN||hook==Hook.CLEANUP){
                code.aload(1);enter(code);
            }
            first=code.newLabel();last=code.newLabel();failed=code.newLabel();code.labelBinding(first);
        }
        private void enter(CodeBuilder code){
            int object=code.allocateLocal(TypeKind.REFERENCE);
            code.astore(object).aload(0).aload(object).ldc(hook.ordinal())
                .invokestatic(HELPER,"enter",MethodTypeDesc.of(OBJECT,OBJECT,OBJECT,INT)).astore(local);
        }
        @Override public void accept(CodeBuilder code,CodeElement element){
            if((hook==Hook.COMMIT||hook==Hook.ROLLBACK)&&call(element,STATUS,"getTransaction","()"+ARG_OBJECT)){
                objects++;code.with(element).dup();enter(code);return;
            }
            if(hook==Hook.BEGIN&&call(element,MANAGER,"obtainEntityManagerFactory","()"+FACTORY_DESC)){
                factories++;code.with(element).dup().aload(local).invokestatic(HELPER,"effectiveFactory",MethodTypeDesc.of(VOID,OBJECT,OBJECT));return;
            }
            if(hook==Hook.BEGIN&&call(element,"org/springframework/transaction/TransactionDefinition","isReadOnly","()Z")){
                flags++;code.with(element).dup().aload(local).invokestatic(HELPER,"readOnly",MethodTypeDesc.of(VOID,BOOLEAN,OBJECT));return;
            }
            boolean begin=hook==Hook.BEGIN&&call(element,JPA+"JpaDialect","beginTransaction",
                "(Ljakarta/persistence/EntityManager;"+DEFINITION+")"+ARG_OBJECT);
            boolean finish=(hook==Hook.COMMIT||hook==Hook.ROLLBACK)&&call(element,ENTITY_TX,hook.key,"()V");
            if(begin||finish){
                calls++;signal(code,"reaching");code.with(element);signal(code,"providerReturned");return;
            }
            if(element instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.VOID){exits++;exit(code,false);}
            code.with(element);
        }
        private void signal(CodeBuilder code,String name){
            code.aload(local).invokestatic(HELPER,name,MethodTypeDesc.of(VOID,OBJECT));
        }
        private void exit(CodeBuilder code,boolean threw){
            if(threw)code.iconst_1();else code.iconst_0();
            code.aload(local).invokestatic(HELPER,"finished",MethodTypeDesc.of(VOID,BOOLEAN,OBJECT));
        }
        @Override public void atEnd(CodeBuilder code){
            code.labelBinding(last).labelBinding(failed);exit(code,true);
            code.athrow().exceptionCatchAll(first,last,failed);
        }
    }
}
