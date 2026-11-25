package rocketbrain.signature;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.TypeMirror;
import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.object;

/** Attributes one call and checks the argument/parameter bindings of its reviewed replacement. */
final class InlineMethodInspector {
    private static final Set<Modifier> MODIFIERS = Set.of(Modifier.PRIVATE,Modifier.STATIC,Modifier.FINAL);
    private final Trees trees;
    private final SourcePositions positions;
    private final CompilationUnitTree unit;
    private final String source;

    InlineMethodInspector(JavacTask task, CompilationUnitTree unit, String source) {
        this.trees = Trees.instance(task);
        this.positions = trees.getSourcePositions();
        this.unit = unit;
        this.source = source;
    }

    private int start(Tree tree) { return (int)positions.getStartPosition(unit,tree); }
    private int end(Tree tree) { return (int)positions.getEndPosition(unit,tree); }
    private Map<String,Object> range(Tree tree) { return object("start",start(tree),"end",end(tree)); }
    private Map<String,Object> error(String message) { return object("error",message); }

    private String supportedType(TypeMirror type) {
        if (type == null) return null;
        String name = type.toString();
        return type.getKind().isPrimitive() && type.getAnnotationMirrors().isEmpty() || name.equals("java.lang.String") ? name : null;
    }

    private TreePath placement(TreePath expression) {
        TreePath statement = expression.getParentPath();
        while (statement != null && statement.getLeaf() instanceof ParenthesizedTree) statement = statement.getParentPath();
        if (statement == null || statement.getParentPath() == null || !(statement.getParentPath().getLeaf() instanceof BlockTree)) return null;
        Tree leaf = statement.getLeaf();
        if (leaf instanceof ReturnTree) return statement;
        if (leaf instanceof VariableTree variable && trees.getElement(statement) instanceof VariableElement local &&
                local.getKind() == ElementKind.LOCAL_VARIABLE && variable.getInitializer() != null) {
            int from=start(variable), to=end(variable);
            if (from<0 || to<=from || source.charAt(to-1)!=';') return null;
            var siblings=((BlockTree)statement.getParentPath().getLeaf()).getStatements();
            for (StatementTree sibling:siblings) {
                if (sibling!=variable && sibling instanceof VariableTree && start(sibling)<to && end(sibling)>from) return null;
            }
            return statement;
        }
        return null;
    }

    private ExecutableElement caller(TreePath path) {
        for (TreePath current=path;current!=null;current=current.getParentPath()) {
            if (current.getLeaf() instanceof LambdaExpressionTree) return null;
            if (current.getLeaf() instanceof MethodTree && trees.getElement(current) instanceof ExecutableElement method) return method;
        }
        return null;
    }

    private String siteType(TreePath statement, ExecutableElement caller) {
        if (statement.getLeaf() instanceof VariableTree) return trees.getElement(statement).asType().toString();
        return caller.getReturnType().toString();
    }

    private boolean supportsExpressionNode(Tree tree) {
        return switch (tree.getKind()) {
            case IDENTIFIER, PARENTHESIZED, CONDITIONAL_EXPRESSION, TYPE_CAST, PRIMITIVE_TYPE,
                 INT_LITERAL, LONG_LITERAL, FLOAT_LITERAL, DOUBLE_LITERAL, BOOLEAN_LITERAL, CHAR_LITERAL,
                 STRING_LITERAL, NULL_LITERAL, PLUS, MINUS, MULTIPLY, DIVIDE, REMAINDER, LEFT_SHIFT,
                 RIGHT_SHIFT, UNSIGNED_RIGHT_SHIFT, LESS_THAN, LESS_THAN_EQUAL, GREATER_THAN,
                 GREATER_THAN_EQUAL, EQUAL_TO, NOT_EQUAL_TO, AND, OR, XOR, CONDITIONAL_AND,
                 CONDITIONAL_OR, UNARY_PLUS, UNARY_MINUS, BITWISE_COMPLEMENT, LOGICAL_COMPLEMENT -> true;
            default -> false;
        };
    }

    private List<Map<String,Object>> bodyReferences(TreePath expression, List<? extends VariableElement> formals) {
        if (!supportsExpressionNode(expression.getLeaf())) return null;
        var references = new ArrayList<Map<String,Object>>();
        boolean[] valid = {true};
        new TreePathScanner<Void,Void>() {
            @Override public Void scan(Tree tree, Void unused) {
                if (tree == null || !valid[0]) return null;
                if (!supportsExpressionNode(tree)) { valid[0]=false; return null; }
                return super.scan(tree,unused);
            }

            @Override public Void visitIdentifier(IdentifierTree tree, Void unused) {
                int ordinal = formals.indexOf(trees.getElement(getCurrentPath()));
                int from=start(tree), to=end(tree);
                if (ordinal<0 || from<0 || to<=from || !source.substring(from,to).contentEquals(tree.getName())) {
                    valid[0]=false;
                    return null;
                }
                references.add(object("index",ordinal,"start",from,"end",to));
                return null;
            }

            @Override public Void visitTypeCast(TypeCastTree tree, Void unused) {
                if (!(tree.getType() instanceof PrimitiveTypeTree)) { valid[0]=false; return null; }
                return super.visitTypeCast(tree,unused);
            }
        }.scan(expression,null);
        return valid[0] ? references : null;
    }

    private String binding(Element element) {
        if (element == null) return "";
        var parts = new ArrayList<String>();
        for (Element current=element; current!=null; current=current.getEnclosingElement()) {
            if (current instanceof TypeElement type) {
                parts.add(type.getQualifiedName().toString());
                break;
            }
            parts.add(current.getKind()+":"+current.toString()+":"+current.asType().toString());
        }
        return String.join("|",parts);
    }

    private Map<String,Object> argument(TreePath expression) {
        var references=new ArrayList<String>();
        new TreePathScanner<Void,Void>() {
            private void record() { references.add(binding(trees.getElement(getCurrentPath()))); }
            @Override public Void visitIdentifier(IdentifierTree tree,Void unused) { record(); return super.visitIdentifier(tree,unused); }
            @Override public Void visitMemberSelect(MemberSelectTree tree,Void unused) { record(); return super.visitMemberSelect(tree,unused); }
            @Override public Void visitNewClass(NewClassTree tree,Void unused) { record(); return super.visitNewClass(tree,unused); }
            @Override public Void visitMemberReference(MemberReferenceTree tree,Void unused) { record(); return super.visitMemberReference(tree,unused); }
        }.scan(expression,null);
        return object("type",trees.getTypeMirror(expression).toString(),"bindings",references);
    }

    private Set<String> usedNames() {
        var names = new LinkedHashSet<String>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitVariable(VariableTree tree,Void unused) {
                names.add(tree.getName().toString()); return super.visitVariable(tree,unused);
            }
            @Override public Void visitIdentifier(IdentifierTree tree,Void unused) {
                names.add(tree.getName().toString()); return super.visitIdentifier(tree,unused);
            }
        }.scan(unit,null);
        return names;
    }

    private Map<String,Object> plan(int from,int to) {
        var matches=new ArrayList<TreePath>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitMethodInvocation(MethodInvocationTree call,Void unused) {
                Tree select=call.getMethodSelect();
                boolean atName=from==to && start(select)<=from && from<end(select) || from==start(select) && to==end(select);
                if (atName || from==start(call) && to==end(call)) matches.add(getCurrentPath());
                return super.visitMethodInvocation(call,unused);
            }
        }.scan(unit,null);
        if (matches.size()!=1) return error("Select one complete Java method call or put the cursor on its name.");
        TreePath selected=matches.get(0), statement=placement(selected);
        ExecutableElement caller=caller(selected);
        if (statement==null || caller==null) return error("Select the whole return expression or a local initializer in an ordinary Java method block.");
        MethodInvocationTree call=(MethodInvocationTree)selected.getLeaf();
        if (!(call.getMethodSelect() instanceof IdentifierTree) || !call.getTypeArguments().isEmpty() ||
                !(trees.getElement(selected) instanceof ExecutableElement target) || !caller.getEnclosingElement().equals(target.getEnclosingElement()) ||
                !(target.getEnclosingElement() instanceof TypeElement owner) || owner.getQualifiedName().length()==0 || !target.getModifiers().containsAll(Set.of(Modifier.PRIVATE,Modifier.STATIC)) ||
                !MODIFIERS.containsAll(target.getModifiers()) || target.isVarArgs() || !target.getTypeParameters().isEmpty() ||
                !target.getThrownTypes().isEmpty() || !target.getAnnotationMirrors().isEmpty() || target.equals(caller)) {
            return error("Inline a non-recursive private static method declared in the same class.");
        }
        TreePath declaration=trees.getPath(target);
        if (declaration==null || declaration.getCompilationUnit()!=unit || !(declaration.getLeaf() instanceof MethodTree method) ||
                method.getBody()==null || method.getBody().getStatements().size()!=1 ||
                !(method.getBody().getStatements().get(0) instanceof ReturnTree returned) || returned.getExpression()==null) {
            return error("The selected method must have one return expression in this Java file.");
        }
        var formals=target.getParameters();
        String resultType=supportedType(target.getReturnType());
        if (resultType==null || formals.size()>16 || formals.size()!=call.getArguments().size()) return error("Use a primitive or String method with up to sixteen arguments.");
        TreePath body=TreePath.getPath(declaration,returned.getExpression());
        var references=bodyReferences(body,formals);
        if (references==null) return error("Inline return expressions made from literals, parameters and supported Java operators.");
        var arguments=new ArrayList<Map<String,Object>>();
        for (int index=0;index<formals.size();index++) {
            VariableElement parameter=formals.get(index);
            String type=supportedType(parameter.asType());
            if (type==null || !parameter.getAnnotationMirrors().isEmpty()) return error("Use primitive or String parameters without annotations.");
            ExpressionTree expression=call.getArguments().get(index);
            arguments.add(object("type",type,"range",range(expression),"expression",argument(new TreePath(selected,expression))));
        }
        return object("method",target.getSimpleName().toString(),"owner",owner.getQualifiedName().toString(),"type",resultType,
                "siteType",siteType(statement,caller),"caller",binding(caller),"call",range(call),"statement",range(statement.getLeaf()),
                "body",range(returned.getExpression()),"arguments",arguments,"references",references,"usedNames",usedNames());
    }

    private Map<String,Object> check(int from,int to,int count) {
        var matches=new ArrayList<TreePath>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitTypeCast(TypeCastTree tree,Void unused) {
                if (from==start(tree) && to==end(tree)) matches.add(getCurrentPath());
                return super.visitTypeCast(tree,unused);
            }
        }.scan(unit,null);
        if (matches.size()!=1) return error("Javac could not verify the replacement's return conversion.");
        TreePath selected=matches.get(0), statement=placement(selected);
        ExecutableElement caller=caller(selected);
        if (statement==null || caller==null) return error("The replacement left the reviewed Java statement.");
        if (statement.getLeaf() instanceof VariableTree && trees.getElement(statement) instanceof VariableElement variable && variable.getConstantValue()!=null) {
            return error("This inline edit would change the original local into a compile-time constant.");
        }
        var siblings=((BlockTree)statement.getParentPath().getLeaf()).getStatements();
        int index=siblings.indexOf(statement.getLeaf());
        if (index<count) return error("The evaluated arguments are missing from the reviewed Java statement.");
        var locals=new ArrayList<VariableElement>();
        var arguments=new ArrayList<Map<String,Object>>();
        for (int i=index-count;i<index;i++) {
            if (!(siblings.get(i) instanceof VariableTree variable) || variable.getInitializer()==null) return error("An argument is not evaluated immediately before the replacement.");
            TreePath local=new TreePath(statement.getParentPath(),variable);
            if (!(trees.getElement(local) instanceof VariableElement element) || element.getKind()!=ElementKind.LOCAL_VARIABLE ||
                    element.getModifiers().contains(Modifier.FINAL)) return error("The argument must retain an independent, nonconstant Java binding.");
            locals.add(element);
            arguments.add(object("name",element.getSimpleName().toString(),"type",supportedType(element.asType()),
                    "expression",argument(new TreePath(local,variable.getInitializer()))));
        }
        var expression=((TypeCastTree)selected.getLeaf()).getExpression();
        var references=bodyReferences(new TreePath(selected,expression),locals);
        if (references==null) return error("The replacement expression does not bind to its exact evaluated arguments.");
        return object("type",supportedType(trees.getTypeMirror(selected)),"siteType",siteType(statement,caller),"caller",binding(caller),
                "arguments",arguments,"references",references.stream().map(record->record.get("index")).toList());
    }

    Map<String,Object> inspect(int from,int to,int argumentCount) {
        return argumentCount<0 ? plan(from,to) : check(from,to,argumentCount);
    }
}
