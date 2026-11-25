package rocketbrain.signature;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.ExecutableType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.object;

/** Observes Java target typing at a simulated expression hole in an in-memory source. */
final class ExpectedCompletion {
    private record Target(TypeMirror type, String context, String call) {}

    private final CompilationUnitTree unit;
    private final Trees trees;
    private final Types types;
    private final Elements elements;
    private final SourcePositions positions;
    private final Map<String,List<TreePath>> declarations=new HashMap<>();
    private final Set<Element> writes=new HashSet<>();

    ExpectedCompletion(JavacTask task, CompilationUnitTree unit) {
        this.unit=unit; trees=Trees.instance(task); types=task.getTypes(); elements=task.getElements(); positions=trees.getSourcePositions();
    }

    private static Map<String,Object> error(String reason) { return object("error",reason); }

    private TypeMirror resultOfLambda(TreePath path) {
        if (!(trees.getTypeMirror(path) instanceof DeclaredType lambda) || !(lambda.asElement() instanceof TypeElement iface) ||
            !elements.isFunctionalInterface(iface)) return null;
        var methods=elements.getAllMembers(iface).stream().filter(member -> member instanceof ExecutableElement &&
                member.getModifiers().contains(Modifier.ABSTRACT)).toList();
        if (methods.size()!=1 || !(types.asMemberOf(lambda,methods.getFirst()) instanceof ExecutableType signature)) return null;
        return signature.getReturnType();
    }

    private Target target(TreePath expression) {
        TreePath parent=expression.getParentPath();
        while (parent!=null && parent.getLeaf() instanceof ParenthesizedTree) parent=parent.getParentPath();
        if (parent==null) return null;
        if (parent.getLeaf() instanceof VariableTree && trees.getElement(parent) instanceof VariableElement variable &&
            variable.getKind()==ElementKind.LOCAL_VARIABLE) return new Target(variable.asType(),"initializer","");
        if (parent.getLeaf() instanceof ReturnTree) {
            for (TreePath current=parent;current!=null;current=current.getParentPath()) {
                if (current.getLeaf() instanceof LambdaExpressionTree) return null;
                if (current.getLeaf() instanceof MethodTree && trees.getElement(current) instanceof ExecutableElement method) {
                    return new Target(method.getReturnType(),"return","");
                }
            }
        }
        if (parent.getLeaf() instanceof LambdaExpressionTree lambda && lambda.getBodyKind()==LambdaExpressionTree.BodyKind.EXPRESSION) {
            String call="";
            TreePath enclosing=parent.getParentPath();
            while (enclosing!=null && enclosing.getLeaf() instanceof ParenthesizedTree) enclosing=enclosing.getParentPath();
            if (enclosing!=null && enclosing.getLeaf() instanceof MethodInvocationTree &&
                    trees.getElement(enclosing) instanceof ExecutableElement selected) call=SignatureInspector.key(selected);
            return new Target(resultOfLambda(parent),"lambda",call);
        }
        return null;
    }

    private boolean meaningful(TypeMirror target) {
        return target!=null && (target.getKind()==TypeKind.DECLARED || target.getKind()==TypeKind.ARRAY) &&
                !types.isSameType(target,elements.getTypeElement("java.lang.Object").asType());
    }

    private void indexBindings() {
        new TreePathScanner<Void,Void>() {
            private void written(ExpressionTree expression) {
                Element element=trees.getElement(new TreePath(getCurrentPath(),expression));
                if (element instanceof VariableElement) writes.add(element);
            }
            @Override public Void visitVariable(VariableTree node, Void p) {
                declarations.computeIfAbsent(node.getName().toString(),name->new ArrayList<>()).add(getCurrentPath());
                return super.visitVariable(node,p);
            }
            @Override public Void visitAssignment(AssignmentTree node, Void p) {
                written(node.getVariable());
                return super.visitAssignment(node,p);
            }
            @Override public Void visitCompoundAssignment(CompoundAssignmentTree node, Void p) {
                written(node.getVariable());
                return super.visitCompoundAssignment(node,p);
            }
            @Override public Void visitUnary(UnaryTree node, Void p) {
                switch (node.getKind()) {
                    case PREFIX_INCREMENT, PREFIX_DECREMENT, POSTFIX_INCREMENT, POSTFIX_DECREMENT -> written(node.getExpression());
                    default -> { }
                }
                return super.visitUnary(node,p);
            }
        }.scan(unit,null);
    }

    private boolean visibleDeclaration(TreePath declaration, TreePath site, int offset) {
        if (declaration==null || declaration.getCompilationUnit()!=unit || !(declaration.getLeaf() instanceof VariableTree tree)) return false;
        long start=positions.getStartPosition(unit,tree);
        if (start<0 || start>=offset) return false;
        if (!(trees.getElement(declaration) instanceof VariableElement original) || !local(original)) return false;
        if (original.getKind()==ElementKind.LOCAL_VARIABLE && (tree.getInitializer()==null ||
                positions.getEndPosition(unit,tree.getInitializer())<0 || positions.getEndPosition(unit,tree.getInitializer())>offset)) return false;
        Tree scope=declaration.getParentPath().getLeaf();
        boolean captured=false;
        for (TreePath current=site;current!=null;current=current.getParentPath()) {
            if (current.getLeaf()==scope) return !captured || !writes.contains(original);
            if (current.getLeaf() instanceof LambdaExpressionTree || current.getLeaf() instanceof ClassTree) captured=true;
        }
        return false;
    }

    private TreePath declaration(VariableElement variable, TreePath site, int offset) {
        TreePath direct=trees.getPath(variable);
        if (direct!=null) return visibleDeclaration(direct,site,offset)?direct:null;
        // getScope can reattribute a block and return fresh symbols for its locals.
        var found=declarations.getOrDefault(variable.getSimpleName().toString(),List.of()).stream()
            .filter(path->visibleDeclaration(path,site,offset) && trees.getElement(path) instanceof VariableElement original &&
                original.getKind()==variable.getKind() && types.isSameType(original.asType(),variable.asType())).toList();
        return found.size()==1?found.getFirst():null;
    }

    private boolean compatible(VariableElement variable, TypeMirror target) {
        TypeMirror from=variable.asType();
        if (from instanceof DeclaredType declared && declared.getTypeArguments().isEmpty() &&
                declared.asElement() instanceof TypeElement type && !type.getTypeParameters().isEmpty()) return false;
        return !from.getKind().isPrimitive() && (types.isSameType(from,target) || types.isSubtype(from,target));
    }

    private Map<String,Object> variable(VariableElement variable, TreePath declaration) {
        return object("name",variable.getSimpleName().toString(),"type",variable.asType().toString(),
                "kind",variable.getKind().name(),"declarationStart",positions.getStartPosition(unit,declaration.getLeaf()));
    }

    private boolean local(VariableElement variable) {
        return variable.getKind()==ElementKind.LOCAL_VARIABLE || variable.getKind()==ElementKind.PARAMETER ||
               variable.getKind()==ElementKind.EXCEPTION_PARAMETER;
    }

    private List<Map<String,Object>> candidates(TreePath site, int offset, TypeMirror match) {
        var result=new ArrayList<Map<String,Object>>();
        var names=new HashSet<String>();
        for (Scope scope=trees.getScope(site);scope!=null;scope=scope.getEnclosingScope()) {
            for (Element element:scope.getLocalElements()) {
                if (!(element instanceof VariableElement variable) || !local(variable) || !names.add(variable.getSimpleName().toString()) ||
                    !compatible(variable,match)) continue;
                TreePath declaration=declaration(variable,site,offset);
                if (declaration==null) continue;
                result.add(variable(variable,declaration));
                if (result.size()>160) throw new IllegalArgumentException("Too many type-compatible bindings in this Java expression.");
            }
        }
        result.sort(Comparator.comparing(item -> item.get("name").toString()));
        return result;
    }

    Map<String,Object> inspect(int start, int end, boolean plan) {
        var exact=new ArrayList<TreePath>();
        new TreePathScanner<Void,Void>() {
            private void record(Tree tree) {
                if (positions.getStartPosition(unit,tree)==start && positions.getEndPosition(unit,tree)==end) exact.add(getCurrentPath());
            }
            @Override public Void visitLiteral(LiteralTree tree, Void p) {
                if (plan && tree.getKind()==Tree.Kind.NULL_LITERAL) record(tree);
                return super.visitLiteral(tree,p);
            }
            @Override public Void visitIdentifier(IdentifierTree tree, Void p) {
                if (!plan) record(tree);
                return super.visitIdentifier(tree,p);
            }
        }.scan(unit,null);
        if (exact.size()!=1) return error("Place the cursor on a standalone unfinished Java value.");
        TreePath site=exact.getFirst();
        Target target=target(site);
        if (target==null || !meaningful(target.type())) return error("Use a local initializer, return or lambda expression with a concrete reference target type.");
        indexBindings();
        var report=object("expectedType",target.type().toString(),"context",target.context(),"call",target.call());
        if (plan) report.put("candidates",candidates(site,start,target.type()));
        else {
            if (!(trees.getElement(site) instanceof VariableElement binding) || !compatible(binding,target.type())) {
                return error("The completed Java value does not bind to the selected visible declaration.");
            }
            TreePath declaration=declaration(binding,site,start);
            if (declaration==null) return error("The completed Java value does not bind to the selected visible declaration.");
            report.put("selected",variable(binding,declaration));
        }
        return report;
    }
}
