package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.sql.Types;
import java.util.Map;
import java.util.Set;

/** Observes completed standard setters inside the provider's JDBC descriptor package. */
final class JdbcBindHook {
    private static final String PREFIX="org/hibernate/type/descriptor/jdbc/";
    private static final ClassDesc RUNTIME=ClassDesc.of("rocketbrain.observer.PerformanceRuntime");
    private static final ClassDesc OBJECT=ClassDesc.of("java.lang.Object");
    private static final ClassDesc INT=ClassDesc.ofDescriptor("I"), VOID=ClassDesc.ofDescriptor("V");
    private static final Set<String> UNSPECIFIED=Set.of("setObject","setAsciiStream","setBinaryStream","setCharacterStream",
        "setUnicodeStream","setNCharacterStream","setBlob","setClob","setNClob");
    private static final Map<String,Integer> SETTERS=Map.ofEntries(
        Map.entry("setBoolean(IZ)V",Types.BOOLEAN),Map.entry("setByte(IB)V",Types.TINYINT),
        Map.entry("setShort(IS)V",Types.SMALLINT),Map.entry("setInt(II)V",Types.INTEGER),
        Map.entry("setLong(IJ)V",Types.BIGINT),Map.entry("setFloat(IF)V",Types.REAL),
        Map.entry("setDouble(ID)V",Types.DOUBLE),Map.entry("setBigDecimal(ILjava/math/BigDecimal;)V",Types.DECIMAL),
        Map.entry("setString(ILjava/lang/String;)V",Types.VARCHAR),Map.entry("setNString(ILjava/lang/String;)V",Types.NVARCHAR),
        Map.entry("setBytes(I[B)V",Types.VARBINARY),
        Map.entry("setDate(ILjava/sql/Date;)V",Types.DATE),Map.entry("setDate(ILjava/sql/Date;Ljava/util/Calendar;)V",Types.DATE),
        Map.entry("setTime(ILjava/sql/Time;)V",Types.TIME),Map.entry("setTime(ILjava/sql/Time;Ljava/util/Calendar;)V",Types.TIME),
        Map.entry("setTimestamp(ILjava/sql/Timestamp;)V",Types.TIMESTAMP),
        Map.entry("setTimestamp(ILjava/sql/Timestamp;Ljava/util/Calendar;)V",Types.TIMESTAMP),
        Map.entry("setBlob(ILjava/sql/Blob;)V",Types.BLOB),Map.entry("setClob(ILjava/sql/Clob;)V",Types.CLOB),
        Map.entry("setNClob(ILjava/sql/NClob;)V",Types.NCLOB),Map.entry("setArray(ILjava/sql/Array;)V",Types.ARRAY),
        Map.entry("setSQLXML(ILjava/sql/SQLXML;)V",Types.SQLXML),Map.entry("setRowId(ILjava/sql/RowId;)V",Types.ROWID));

    private JdbcBindHook(){}

    static boolean owner(String name){return name!=null&&name.startsWith(PREFIX);}

    static byte[] transform(ClassFile cf,ClassModel model){
        int[] hooks={0};
        byte[] bytes=cf.transformClass(model,(builder,element)->{
            if(element instanceof MethodModel method&&method.code().isPresent()){
                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                    if(instruction instanceof InvokeInstruction call&&observe(code,call))hooks[0]++;
                    else code.with(instruction);
                }));
            }else builder.with(element);
        });
        return hooks[0]==0?null:bytes;
    }

    private static boolean observe(CodeBuilder code,InvokeInstruction call){
        if(!call.owner().asInternalName().equals("java/sql/PreparedStatement"))return false;
        String signature=call.type().stringValue(),name=call.name().stringValue(),operation=name+signature;
        if(operation.equals("clearParameters()V")){
            int statement=code.allocateLocal(TypeKind.REFERENCE);
            code.dup().astore(statement).with(call);
            code.aload(statement).invokestatic(RUNTIME,"clearBinds",MethodTypeDesc.of(VOID,OBJECT));
            return true;
        }
        Integer fixed=SETTERS.get(operation);
        int argument=switch(operation){
            case "setNull(II)V","setNull(IILjava/lang/String;)V" -> 1;
            case "setObject(ILjava/lang/Object;I)V","setObject(ILjava/lang/Object;II)V",
                "setObject(ILjava/lang/Object;Ljava/sql/SQLType;)V","setObject(ILjava/lang/Object;Ljava/sql/SQLType;I)V" -> 2;
            default -> -1;
        };
        if(fixed==null&&argument<0&&!(UNSPECIFIED.contains(name)&&signature.startsWith("(I")&&signature.endsWith(")V")))return false;

        var parameters=MethodTypeDesc.ofDescriptor(signature).parameterList();
        int[] locals=new int[parameters.size()];
        for(int index=locals.length-1;index>=0;index--){
            TypeKind kind=TypeKind.from(parameters.get(index)).asLoadable();
            locals[index]=code.allocateLocal(kind);
            code.storeLocal(kind,locals[index]);
        }
        int statement=code.allocateLocal(TypeKind.REFERENCE);
        code.dup().astore(statement);
        for(int index=0;index<locals.length;index++)code.loadLocal(TypeKind.from(parameters.get(index)).asLoadable(),locals[index]);
        code.with(call);

        // Only the statement identity, index and JDBC type go to the observer.
        code.aload(statement).iload(locals[0]);
        if(argument>=0&&parameters.get(argument).equals(INT)){
            code.iload(locals[argument]).invokestatic(RUNTIME,"explicitBind",MethodTypeDesc.of(VOID,OBJECT,INT,INT));
        }else if(argument>=0){
            code.aload(locals[argument]).invokestatic(RUNTIME,"explicitBindType",MethodTypeDesc.of(VOID,OBJECT,INT,OBJECT));
        }else if(fixed!=null){
            code.ldc(fixed).invokestatic(RUNTIME,"typedBind",MethodTypeDesc.of(VOID,OBJECT,INT,INT));
        }else code.invokestatic(RUNTIME,"untypedBind",MethodTypeDesc.of(VOID,OBJECT,INT));
        return true;
    }
}
