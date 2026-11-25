package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.Elements;
import static rocketbrain.signature.SignatureInspector.object;

/** Proves a trailing sequence and the exact call replacing it using attributed source. */
final class ExtractMethodInspector {
    private final Trees trees;
    private final Elements elements;
    private final SourcePositions positions;
    private final CompilationUnitTree unit;
    private final String text;

    ExtractMethodInspector(JavacTask task, CompilationUnitTree unit, String text) {
        trees = Trees.instance(task);
        elements = task.getElements();
        positions = trees.getSourcePositions();
        this.unit = unit;
        this.text = text;
    }

    private int start(Tree tree) { return (int)positions.getStartPosition(unit,tree); }
    private int end(Tree tree) { return (int)positions.getEndPosition(unit,tree); }
    private String source(Tree tree) { return text.substring(start(tree),end(tree)); }
    private Map<String,Object> error(String reason) { return object("error",reason); }

    Map<String,Object> inspect(int from, int to, String name, int callOffset) {
        List<TreePath> paths = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitMethod(MethodTree method, Void unused) {
                if (method.getBody()!=null && start(method.getBody())<from && to<end(method.getBody())) paths.add(getCurrentPath());
                return super.visitMethod(method,unused);
            }
        }.scan(unit,null);
        if (paths.size()!=1) return error("Select trailing statements in one ordinary named Java method.");
        TreePath path = paths.getFirst();
        MethodTree method = (MethodTree)path.getLeaf();
        if (!(trees.getElement(path) instanceof ExecutableElement declaration) || declaration.getKind()!=ElementKind.METHOD ||
            !(declaration.getEnclosingElement() instanceof TypeElement owner) || owner.getKind()!=ElementKind.CLASS ||
            !Set.of(NestingKind.TOP_LEVEL,NestingKind.MEMBER).contains(owner.getNestingKind()) ||
            declaration.getReturnType().getKind()==TypeKind.VOID) {
            return error("Select a non-void method in an ordinary named Java class.");
        }
        var statements = method.getBody().getStatements();
        int first=0;
        while (first<statements.size() && start(statements.get(first))<from) first++;
        var selected = statements.subList(first,statements.size());
        if (selected.size()<2 || start(selected.getFirst())!=from || end(selected.getLast())!=to ||
            !(selected.getLast() instanceof ReturnTree returned) || returned.getExpression()==null) {
            return error("Select at least two complete trailing statements ending with a return value.");
        }
        if (callOffset<0 && nameUsed(owner,name)) return error("Choose a new method name unused in the current Java source and its hierarchy.");
        if (callOffset>=0 && (!declaration.getSimpleName().contentEquals(name) ||
            !declaration.getModifiers().contains(Modifier.PRIVATE) || first!=0)) {
            return error("Javac could not verify the generated private helper.");
        }
        BodyProof body = new BodyProof(declaration,from,to);
        TreePath block = new TreePath(path,method.getBody());
        for (StatementTree statement : selected) {
            if (body.supports(statement)) body.scan(new TreePath(block,statement),null);
            else body.invalid=true;
        }
        if (body.invalid) return error("Use local statements and if, return or throw. Captured writes, nonlocal control flow, local types and nested lambdas are unsupported.");
        Map<String,Object> result = object("owner",owner.getQualifiedName().toString(),"className",owner.getSimpleName().toString(),
            "method",SignatureInspector.key(declaration),"staticMethod",declaration.getModifiers().contains(Modifier.STATIC),
            "methodEnd",end(method),"methodStart",start(method),"start",from,"end",to,"statementCount",selected.size(),
            "sourceReturn",source(method.getReturnType()),"returnType",declaration.getReturnType().toString(),
            "sourceTypeParameters",method.getTypeParameters().stream().map(this::source).toList(),
            "typeNames",declaration.getTypeParameters().stream().map(parameter->parameter.getSimpleName().toString()).toList(),
            "sourceThrows",method.getThrows().stream().map(this::source).toList(),
            "throwsTypes",declaration.getThrownTypes().stream().map(Object::toString).toList(),
            "captures",body.captures.keySet().stream().map(this::variable).toList(),
            "bindings",body.bindings,"selected",selected.stream().map(Object::toString).toList());
        if (callOffset>=0) {
            result.put("parameters",declaration.getParameters().stream().map(this::variable).toList());
            result.put("call",call(callOffset,declaration));
        }
        return result;
    }

    private Map<String,Object> variable(VariableElement element) {
        TreePath path = trees.getPath(element);
        return object("name",element.getSimpleName().toString(),"type",element.asType().toString(),
            "start",path==null||path.getCompilationUnit()!=unit?-1:start(path.getLeaf()));
    }

    private boolean nameUsed(TypeElement owner, String name) {
        if (elements.getAllMembers(owner).stream().anyMatch(member->member instanceof ExecutableElement method &&
            method.getSimpleName().contentEquals(name))) return true;
        boolean[] used = {false};
        new TreeScanner<Void,Void>() {
            @Override public Void visitIdentifier(IdentifierTree tree,Void unused) {
                used[0]|=tree.getName().contentEquals(name);return super.visitIdentifier(tree,unused);
            }
            @Override public Void visitMemberSelect(MemberSelectTree tree,Void unused) {
                used[0]|=tree.getIdentifier().contentEquals(name);return super.visitMemberSelect(tree,unused);
            }
            @Override public Void visitMemberReference(MemberReferenceTree tree,Void unused) {
                used[0]|=tree.getName().contentEquals(name);return super.visitMemberReference(tree,unused);
            }
        }.scan(unit,null);
        return used[0];
    }

    private Map<String,Object> call(int offset, ExecutableElement helper) {
        List<Map<String,Object>> calls = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitMethodInvocation(MethodInvocationTree call, Void unused) {
                TreePath path = getCurrentPath(), parent = path.getParentPath();
                if (start(call)==offset && helper.equals(trees.getElement(path)) && parent.getLeaf() instanceof ReturnTree) {
                    List<Map<String,Object>> arguments = new ArrayList<>();
                    for (ExpressionTree expression : call.getArguments()) {
                        if (!(expression instanceof IdentifierTree) ||
                            !(trees.getElement(new TreePath(path,expression)) instanceof VariableElement variable)) return null;
                        arguments.add(variable(variable));
                    }
                    TreePath caller = parent;
                    while (caller!=null && !(caller.getLeaf() instanceof MethodTree)) caller=caller.getParentPath();
                    if (caller!=null && trees.getElement(caller) instanceof ExecutableElement method) {
                        calls.add(object("caller",SignatureInspector.key(method),"arguments",arguments,
                            "type",trees.getTypeMirror(path).toString()));
                    }
                }
                return super.visitMethodInvocation(call,unused);
            }
        }.scan(unit,null);
        return calls.size()==1?calls.getFirst():null;
    }

    private final class BodyProof extends TreePathScanner<Void,Void> {
        final ExecutableElement method;
        final int from, to;
        final List<String> bindings = new ArrayList<>();
        final Map<VariableElement,Integer> locals = new LinkedHashMap<>(), captures = new LinkedHashMap<>();
        boolean invalid;

        BodyProof(ExecutableElement method,int from,int to) {this.method=method;this.from=from;this.to=to;}

        private boolean supports(Tree tree) {
            boolean unsupportedStatement = tree instanceof StatementTree &&
                !Set.of(Tree.Kind.BLOCK,Tree.Kind.VARIABLE,Tree.Kind.IF,Tree.Kind.RETURN,Tree.Kind.THROW,
                    Tree.Kind.EXPRESSION_STATEMENT).contains(tree.getKind());
            return !(unsupportedStatement || tree instanceof LambdaExpressionTree || tree instanceof MemberReferenceTree ||
                tree instanceof NewClassTree creation && creation.getClassBody()!=null ||
                tree instanceof BindingPatternTree);
        }

        @Override public Void scan(Tree tree,Void unused) {
            if (tree==null || invalid) return null;
            if (!supports(tree)) {invalid=true;return null;}
            return super.scan(tree,unused);
        }

        @Override public Void visitVariable(VariableTree tree,Void unused) {
            if (trees.getElement(getCurrentPath()) instanceof VariableElement local && local.getKind()==ElementKind.LOCAL_VARIABLE) {
                locals.put(local,locals.size());
                bindings.add("declare:"+local.getSimpleName()+":"+local.asType());
            }
            return super.visitVariable(tree,unused);
        }

        private boolean written(TreePath path) {
            Tree leaf=path.getLeaf(), parent=path.getParentPath().getLeaf();
            while (parent instanceof ParenthesizedTree) {
                path=path.getParentPath();
                leaf=parent;
                parent=path.getParentPath().getLeaf();
            }
            return parent instanceof AssignmentTree assignment && assignment.getVariable()==leaf ||
                parent instanceof CompoundAssignmentTree compound && compound.getVariable()==leaf ||
                parent instanceof UnaryTree unary && Set.of(Tree.Kind.PREFIX_INCREMENT,Tree.Kind.PREFIX_DECREMENT,
                    Tree.Kind.POSTFIX_INCREMENT,Tree.Kind.POSTFIX_DECREMENT).contains(unary.getKind());
        }

        private void bind() {
            TreePath path = getCurrentPath();
            Element target = trees.getElement(path);
            TypeMirror type = trees.getTypeMirror(path);
            String identity;
            if (path.getLeaf() instanceof IdentifierTree identifier && Set.of("this","super").contains(identifier.getName().toString())) {
                identity=identifier.getName().toString();
            } else if (target instanceof VariableElement local &&
                Set.of(ElementKind.PARAMETER,ElementKind.LOCAL_VARIABLE).contains(local.getKind())) {
                TreePath declaration=trees.getPath(local);
                if (declaration==null || declaration.getCompilationUnit()!=unit || !local.getEnclosingElement().equals(method)) {
                    invalid=true;return;
                }
                int offset=start(declaration.getLeaf());
                if (offset>=from && offset<to && locals.containsKey(local)) identity="local:"+locals.get(local)+":"+local.getSimpleName();
                else if (offset>=0 && offset<from && !written(path) && local.getConstantValue()==null) {
                    captures.putIfAbsent(local,captures.size());
                    identity="capture:"+captures.get(local)+":"+local.getSimpleName();
                } else {invalid=true;return;}
            } else if (target instanceof ExecutableElement executable) identity=SignatureInspector.key(executable);
            else if (target instanceof TypeParameterElement parameter && parameter.getEnclosingElement().equals(method))
                identity="method-type:"+parameter.getSimpleName();
            else if (target instanceof TypeElement resolved) identity=resolved.getQualifiedName().toString();
            else if (target!=null) identity=target.getKind()+":"+target.getEnclosingElement()+":"+target;
            else {invalid=true;return;}
            bindings.add(path.getLeaf().getKind()+":"+identity+":"+type);
        }
        @Override public Void visitIdentifier(IdentifierTree node,Void unused) {bind();return super.visitIdentifier(node,unused);}
        @Override public Void visitMemberSelect(MemberSelectTree node,Void unused) {bind();return super.visitMemberSelect(node,unused);}
        @Override public Void visitMethodInvocation(MethodInvocationTree node,Void unused) {bind();return super.visitMethodInvocation(node,unused);}
        @Override public Void visitNewClass(NewClassTree node,Void unused) {bind();return super.visitNewClass(node,unused);}
    }
}
